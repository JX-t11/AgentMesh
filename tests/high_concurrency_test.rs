mod common;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{TestApp, TEST_ADMIN_TOKEN};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::net::TcpSocket;
use tokio::sync::Barrier;
use tokio::time::timeout;
use tokio_tungstenite::{client_async, connect_async};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use uuid::Uuid;

const AGENT_COUNT: usize = 24;
const MSGS_PER_AGENT: usize = 10;
const COMMENTS_PER_AGENT: usize = 5;

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn high_concurrency_group_and_forum_storm_zero_deadlock_zero_gap_and_slow_ws_recovery() {
    // 使用较小的有界广播容量（16），在 240+ 并发消息洪峰下强制检验慢消费者隔离与重同步恢复
    let app = Arc::new(TestApp::spawn_with_capacity(16).await);

    let mut agents = Vec::with_capacity(AGENT_COUNT);
    for idx in 0..AGENT_COUNT {
        let fw = if idx % 2 == 0 { "openclaw" } else { "hermes" };
        let (id, token) = app
            .register_agent(&format!("bot-{idx:02}"), &format!("Bot {idx:02}"), fw)
            .await;
        agents.push((id, token));
    }
    let all_agent_ids: Vec<Uuid> = agents.iter().map(|(id, _)| *id).collect();

    // 创建全员所在的热门群组
    let grp_json: Value = app
        .client
        .post(format!("{}/api/v1/admin/groups", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "storm-room",
            "name": "Storm Room",
            "member_agent_ids": all_agent_ids,
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let group_id = Uuid::parse_str(grp_json["group"]["id"].as_str().unwrap()).unwrap();

    // 创建板块与热门主题帖
    let brd_json: Value = app
        .client
        .post(format!("{}/api/v1/admin/boards", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({ "slug": "storm-board", "name": "Storm Board" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let board_id = Uuid::parse_str(brd_json["board"]["id"].as_str().unwrap()).unwrap();

    let post_json: Value = app
        .client
        .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
        .bearer_auth(&agents[0].1)
        .json(&json!({
            "client_req_id": "seed-post",
            "title": "Concurrency Stress Thread",
            "content": "All agents reply here concurrently!",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let post_id = Uuid::parse_str(post_json["post"]["id"].as_str().unwrap()).unwrap();

    // 1. 挂载一个受限 TCP 窗口且故意暂停读取的慢速 Agent WebSocket（测试期间完全不读，验证不阻塞写吞吐）
    let mut slow_req = format!("{}/api/v1/ws/agent", app.ws_base_url)
        .into_client_request()
        .unwrap();
    slow_req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", agents[0].1)).unwrap(),
    );
    let slow_sock = TcpSocket::new_v4().unwrap();
    slow_sock.set_recv_buffer_size(4096).unwrap();
    let slow_tcp = slow_sock.connect(app.addr).await.unwrap();
    let (mut slow_ws, _) = client_async(slow_req, tokio_tungstenite::MaybeTlsStream::Plain(slow_tcp))
        .await
        .unwrap();
    assert_eq!(recv_json(&mut slow_ws).await["type"], "connected");

    // 2. 挂载一个正常持续消费的快客户端，实时消化事件
    let mut fast_req = format!("{}/api/v1/ws/agent", app.ws_base_url)
        .into_client_request()
        .unwrap();
    fast_req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", agents[1].1)).unwrap(),
    );
    let (mut fast_ws, _) = connect_async(fast_req).await.unwrap();
    assert_eq!(recv_json(&mut fast_ws).await["type"], "connected");

    let fast_reader = tokio::spawn(async move {
        let mut received_frames = 0usize;
        while let Ok(Some(Ok(msg))) = timeout(Duration::from_millis(400), fast_ws.next()).await {
            if matches!(msg, WsMsg::Text(_)) {
                received_frames += 1;
            }
        }
        received_frames
    });

    // 3. 启动并发实时增量轮询器：在写入风暴进行的同时高频执行 after_seq 增量拉取，检验零乱序漏读
    let total_expected_group_msgs = AGENT_COUNT * MSGS_PER_AGENT;
    let poller_app = Arc::clone(&app);
    let poller = tokio::spawn(async move {
        let mut cursor = 0_i64;
        let mut seen_seqs = Vec::with_capacity(total_expected_group_msgs);
        let deadline = Instant::now() + Duration::from_secs(20);

        while seen_seqs.len() < total_expected_group_msgs && Instant::now() < deadline {
            let page: Value = poller_app
                .client
                .get(format!(
                    "{}/api/v1/groups/{group_id}/messages?after_seq={cursor}&limit=17",
                    poller_app.base_url
                ))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();

            let items = page["messages"].as_array().unwrap();
            if items.is_empty() {
                tokio::time::sleep(Duration::from_millis(2)).await;
                continue;
            }
            for item in items {
                let s = item["seq"].as_i64().unwrap();
                seen_seqs.push(s);
                cursor = s;
            }
        }
        seen_seqs
    });

    // 4. 24 个并发 Agent 任务通过 Barrier 同时开火：高频群消息 + 相反顺序交叉 @ + 同帖并发评论 + 并发幂等重发
    let barrier = Arc::new(Barrier::new(AGENT_COUNT));
    let hot_targets = [
        all_agent_ids[0],
        all_agent_ids[5],
        all_agent_ids[11],
        all_agent_ids[17],
        all_agent_ids[23],
    ];

    let storm_start = Instant::now();
    let mut handles = Vec::with_capacity(AGENT_COUNT);
    for (idx, (_agent_id, token)) in agents.iter().cloned().enumerate() {
        let app_ref = Arc::clone(&app);
        let bar = Arc::clone(&barrier);
        handles.push(tokio::spawn(async move {
            // 故意让奇偶任务传入完全相反顺序的同一批 @ 目标，最大化交叉行锁竞争测试无死锁保证
            let mentions: Vec<Uuid> = if idx % 2 == 0 {
                hot_targets.to_vec()
            } else {
                hot_targets.iter().copied().rev().collect()
            };

            bar.wait().await;

            for m in 0..MSGS_PER_AGENT {
                let cid = format!("storm-g-{idx}-{m}");
                let payload = json!({
                    "client_msg_id": cid,
                    "content": format!("Agent {idx} burst message #{m} - {}", "x".repeat(12288)),
                    "mention_agent_ids": mentions,
                });
                let resp = app_ref
                    .client
                    .post(format!("{}/api/v1/groups/{group_id}/messages", app_ref.base_url))
                    .bearer_auth(&token)
                    .json(&payload)
                    .send()
                    .await
                    .expect("group post http ok");
                assert!(
                    resp.status() == 201 || resp.status() == 200,
                    "unexpected group status: {}",
                    resp.status()
                );

                // 每第 5 条消息顺带并发触发一次同 client_msg_id 幂等重试
                if m % 5 == 0 {
                    let dup = app_ref
                        .client
                        .post(format!("{}/api/v1/groups/{group_id}/messages", app_ref.base_url))
                        .bearer_auth(&token)
                        .json(&payload)
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(dup.status(), 200);
                }
            }

            for c in 0..COMMENTS_PER_AGENT {
                let cid = format!("storm-c-{idx}-{c}");
                let resp = app_ref
                    .client
                    .post(format!("{}/api/v1/posts/{post_id}/comments", app_ref.base_url))
                    .bearer_auth(&token)
                    .json(&json!({
                        "client_req_id": cid,
                        "content": format!("Agent {idx} concurrent comment #{c}"),
                        "mention_agent_ids": mentions,
                    }))
                    .send()
                    .await
                    .expect("comment post http ok");
                assert_eq!(
                    resp.status(),
                    201,
                    "unexpected comment status: {}",
                    resp.status()
                );
            }
        }));
    }

    for h in handles {
        h.await.expect("writer task panicked or deadlocked");
    }
    let storm_elapsed = storm_start.elapsed();
    assert!(
        storm_elapsed < Duration::from_secs(15),
        "write storm should not be blocked by slow consumer, took {storm_elapsed:?}"
    );

    // 5. 检验不变量 1：实时增量轮询器完整拿到 1..=240 连续严格递增序号，零空洞零漏读！
    let polled_seqs = poller.await.unwrap();
    let expected_seqs: Vec<i64> = (1..=(total_expected_group_msgs as i64)).collect();
    assert_eq!(polled_seqs, expected_seqs);

    let fast_count = fast_reader.await.unwrap();
    assert!(fast_count > 0);

    // 6. 检验不变量 2：帖子评论计数精确等于 120，且 Keyset 游标分页全量拉取无重复无遗漏
    let total_expected_comments = AGENT_COUNT * COMMENTS_PER_AGENT;
    let post_after: Value = app
        .client
        .get(format!("{}/api/v1/posts/{post_id}", app.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        post_after["post"]["comment_count"].as_u64().unwrap() as usize,
        total_expected_comments
    );

    let mut cursor: Option<String> = None;
    let mut collected_comments = HashSet::new();
    loop {
        let url = match &cursor {
            Some(c) => format!(
                "{}/api/v1/posts/{post_id}/comments?limit=35&cursor={c}",
                app.base_url
            ),
            None => format!("{}/api/v1/posts/{post_id}/comments?limit=35", app.base_url),
        };
        let page: Value = app.client.get(url).send().await.unwrap().json().await.unwrap();
        for item in page["comments"].as_array().unwrap() {
            let id = Uuid::parse_str(item["id"].as_str().unwrap()).unwrap();
            assert!(collected_comments.insert(id), "duplicate comment in cursor pagination");
        }
        if !page["has_more"].as_bool().unwrap() {
            break;
        }
        cursor = page["next_cursor"].as_str().map(str::to_owned);
    }
    assert_eq!(collected_comments.len(), total_expected_comments);

    // 7. 检验不变量 3：每个被高频交叉 @ 的目标 Agent 的个人 inbox_seq 严格从 1 连续递增无空洞！
    for &(agent_id, ref token) in &agents {
        let mut inbox_cursor = 0_i64;
        let mut inbox_seqs = Vec::new();
        loop {
            let page: Value = app
                .client
                .get(format!(
                    "{}/api/v1/inbox?after_inbox_seq={inbox_cursor}&limit=100",
                    app.base_url
                ))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            for item in page["items"].as_array().unwrap() {
                let s = item["inbox_seq"].as_i64().unwrap();
                inbox_seqs.push(s);
                inbox_cursor = s;
            }
            if !page["has_more"].as_bool().unwrap() {
                break;
            }
        }
        let expected_inbox: Vec<i64> = (1..=(inbox_seqs.len() as i64)).collect();
        assert_eq!(
            inbox_seqs, expected_inbox,
            "agent {agent_id} inbox_seq must be strictly contiguous"
        );
        if hot_targets.contains(&agent_id) {
            // 23 个其他 Agent * (10 条群 @ + 5 条评论 @) = 345 条定向通知！
            assert_eq!(inbox_seqs.len(), (AGENT_COUNT - 1) * (MSGS_PER_AGENT + COMMENTS_PER_AGENT));
        }
    }

    // 8. 检验不变量 4：慢消费者恢复读取后收到 resync_required，并通过游标追平至权威完整状态
    let mut saw_group_resync = false;
    let mut saw_inbox_resync = false;
    let mut last_ws_group_seq = 0_i64;
    let mut group_map = std::collections::BTreeMap::<i64, Uuid>::new();

    while let Ok(frame) = timeout(Duration::from_millis(200), recv_json(&mut slow_ws)).await {
        match frame["type"].as_str().unwrap_or_default() {
            "group_message" => {
                let seq = frame["message"]["seq"].as_i64().unwrap();
                let id = Uuid::parse_str(frame["message"]["id"].as_str().unwrap()).unwrap();
                group_map.insert(seq, id);
            }
            "resync_required" => {
                match frame["scope"].as_str().unwrap_or_default() {
                    "group" => {
                        saw_group_resync = true;
                        // 模拟客户端标准恢复流程：从本地已知连续水位线 last_ws_group_seq 增量拉取追平
                        loop {
                            let page: Value = app
                                .client
                                .get(format!(
                                    "{}/api/v1/groups/{group_id}/messages?after_seq={last_ws_group_seq}&limit=100",
                                    app.base_url
                                ))
                                .send()
                                .await
                                .unwrap()
                                .json()
                                .await
                                .unwrap();
                            for m in page["messages"].as_array().unwrap() {
                                let seq = m["seq"].as_i64().unwrap();
                                let id = Uuid::parse_str(m["id"].as_str().unwrap()).unwrap();
                                group_map.insert(seq, id);
                                last_ws_group_seq = seq;
                            }
                            if !page["has_more"].as_bool().unwrap() {
                                break;
                            }
                        }
                    }
                    "inbox" => {
                        saw_inbox_resync = true;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        if saw_group_resync && saw_inbox_resync && group_map.len() == total_expected_group_msgs {
            break;
        }
    }

    assert!(saw_group_resync, "slow consumer must observe group resync_required (inbox_resync={saw_inbox_resync}, map_len={})", group_map.len());
    // 注：inbox 帧只有 ~200B 且在独立的 agent_rx 通道（容量 16），若慢客户端在阻塞期间积压超过 16 条定向通知同样会触发或直接追平收件箱
    let mut recovered_inbox_cursor = 0_i64;
    let mut recovered_inbox_count = 0usize;
    loop {
        let page: Value = app
            .client
            .get(format!(
                "{}/api/v1/inbox?after_inbox_seq={recovered_inbox_cursor}&limit=100",
                app.base_url
            ))
            .bearer_auth(&agents[0].1)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        for item in page["items"].as_array().unwrap() {
            recovered_inbox_cursor = item["inbox_seq"].as_i64().unwrap();
            recovered_inbox_count += 1;
        }
        if !page["has_more"].as_bool().unwrap() {
            break;
        }
    }
    assert_eq!(
        recovered_inbox_count,
        (AGENT_COUNT - 1) * (MSGS_PER_AGENT + COMMENTS_PER_AGENT)
    );
    assert_eq!(group_map.len(), total_expected_group_msgs);
    let recovered_seqs: Vec<i64> = group_map.keys().copied().collect();
    assert_eq!(recovered_seqs, expected_seqs);

    drop(slow_ws);
    if let Ok(owned_app) = Arc::try_unwrap(app) {
        owned_app.cleanup().await;
    }
}

async fn recv_json(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Value {
    loop {
        let msg = timeout(Duration::from_secs(2), ws.next())
            .await
            .expect("ws recv timeout")
            .expect("ws stream ended")
            .expect("ws frame ok");
        if let WsMsg::Text(txt) = msg {
            return serde_json::from_str(txt.as_str()).expect("valid json frame");
        }
    }
}
