mod common;

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{TestApp, TEST_ADMIN_TOKEN};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::net::TcpSocket;
use tokio::net::TcpStream;
use tokio::sync::Barrier;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, Request};
use tokio_tungstenite::tungstenite::protocol::Message as WsMsg;
use tokio_tungstenite::{client_async, connect_async, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

const AGENT_COUNT: usize = 24;
const MSGS_PER_AGENT: usize = 10;
const COMMENTS_PER_AGENT: usize = 5;

type TestWs = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct StormFixture {
    app: Arc<TestApp>,
    agents: Vec<(Uuid, String)>,
    all_agent_ids: Vec<Uuid>,
    group_id: Uuid,
    post_id: Uuid,
}

struct SlowRecovery {
    group_map: BTreeMap<i64, Uuid>,
    last_group_seq: i64,
    saw_group_resync: bool,
    saw_inbox_resync: bool,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn high_concurrency_group_and_forum_storm_zero_deadlock_zero_gap_and_slow_ws_recovery() {
    // 使用较小的有界广播容量（16），在 240+ 并发消息洪峰下强制检验慢消费者隔离与重同步恢复
    let fixture = spawn_storm_fixture(16).await;
    let total_group_msgs = fixture.agents.len() * MSGS_PER_AGENT;
    let total_comments = fixture.agents.len() * COMMENTS_PER_AGENT;

    let mut slow_ws = connect_slow_agent_ws(&fixture.app, &fixture.agents[0].1).await;
    assert_eq!(recv_json(&mut slow_ws).await["type"], "connected");
    let fast_reader = connect_fast_agent_ws(&fixture.app, &fixture.agents[1].1).await;

    let poller_app = Arc::clone(&fixture.app);
    let poller_group_id = fixture.group_id;
    let poller = tokio::spawn(poll_group_messages(
        poller_app,
        poller_group_id,
        total_group_msgs,
    ));

    let storm_start = Instant::now();
    let mut handles = spawn_storm_writers(&fixture).await;
    for handle in handles.drain(..) {
        handle.await.expect("writer task panicked or deadlocked");
    }
    let storm_elapsed = storm_start.elapsed();
    assert!(
        storm_elapsed < Duration::from_secs(15),
        "write storm should not be blocked by slow consumer, took {storm_elapsed:?}"
    );

    let polled_seqs = poller.await.unwrap();
    assert_eq!(
        polled_seqs,
        (1..=(total_group_msgs as i64)).collect::<Vec<i64>>()
    );
    assert!(fast_reader.await.unwrap() > 0);

    assert_post_comment_pagination(&fixture.app, fixture.post_id, total_comments).await;
    assert_agent_inboxes(&fixture.app, &fixture.agents).await;

    let mut recovery = SlowRecovery {
        group_map: BTreeMap::new(),
        last_group_seq: 0,
        saw_group_resync: false,
        saw_inbox_resync: false,
    };
    recover_slow_consumer(&fixture, &mut slow_ws, &mut recovery, total_group_msgs).await;
    assert_recovered_state(&fixture, recovery, total_group_msgs, total_comments).await;

    drop(slow_ws);
    if let Ok(owned_app) = Arc::try_unwrap(fixture.app) {
        owned_app.cleanup().await;
    }
}

async fn spawn_storm_fixture(broadcast_capacity: usize) -> StormFixture {
    let app = Arc::new(TestApp::spawn_with_capacity(broadcast_capacity).await);
    let mut agents = Vec::with_capacity(AGENT_COUNT);
    for idx in 0..AGENT_COUNT {
        let framework = if idx % 2 == 0 { "openclaw" } else { "hermes" };
        let agent = app
            .register_agent(
                &format!("bot-{idx:02}"),
                &format!("Bot {idx:02}"),
                framework,
            )
            .await;
        agents.push(agent);
    }
    let all_agent_ids: Vec<Uuid> = agents.iter().map(|(id, _)| *id).collect();

    let group_json = post_json(
        &app,
        "/api/v1/admin/groups",
        TEST_ADMIN_TOKEN,
        &json!({
            "slug": "storm-room",
            "name": "Storm Room",
            "member_agent_ids": all_agent_ids,
        }),
    )
    .await;
    let group_id = parse_id(&group_json["group"]["id"]);

    let board_json = post_json(
        &app,
        "/api/v1/admin/boards",
        TEST_ADMIN_TOKEN,
        &json!({ "slug": "storm-board", "name": "Storm Board" }),
    )
    .await;
    let board_id = parse_id(&board_json["board"]["id"]);

    let post_json = post_json(
        &app,
        &format!("/api/v1/boards/{board_id}/posts"),
        &agents[0].1,
        &json!({
            "client_req_id": "seed-post",
            "title": "Concurrency Stress Thread",
            "content": "All agents reply here concurrently!",
        }),
    )
    .await;
    let post_id = parse_id(&post_json["post"]["id"]);

    StormFixture {
        app,
        agents,
        all_agent_ids,
        group_id,
        post_id,
    }
}

async fn post_json(app: &TestApp, path: &str, token: &str, payload: &Value) -> Value {
    let response = app
        .client
        .post(format!("{}{path}", app.base_url))
        .bearer_auth(token)
        .json(payload)
        .send()
        .await
        .expect("post request completed");
    let status = response.status();
    response.json().await.unwrap_or_else(|error| {
        panic!("post {path} returned invalid json with status {status}: {error}")
    })
}

fn parse_id(value: &Value) -> Uuid {
    Uuid::parse_str(value.as_str().expect("valid uuid string")).expect("valid uuid")
}

fn agent_ws_request(app: &TestApp, token: &str) -> Request<()> {
    let mut request = format!("{}/api/v1/ws/agent", app.ws_base_url)
        .into_client_request()
        .expect("agent websocket request");
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).expect("valid bearer header"),
    );
    request
}

async fn connect_slow_agent_ws(app: &TestApp, token: &str) -> TestWs {
    // 受限 TCP 窗口且暂停读取，验证服务端不阻塞写吞吐。
    let request = agent_ws_request(app, token);
    let socket = TcpSocket::new_v4().expect("tcp socket");
    socket
        .set_recv_buffer_size(4096)
        .expect("small recv window");
    let tcp = socket.connect(app.addr).await.expect("slow tcp connect");
    let (ws, _) = client_async(request, MaybeTlsStream::Plain(tcp))
        .await
        .expect("slow websocket handshake");
    ws
}

async fn connect_fast_agent_ws(app: &TestApp, token: &str) -> tokio::task::JoinHandle<usize> {
    let request = agent_ws_request(app, token);
    let (mut ws, _) = connect_async(request)
        .await
        .expect("fast websocket handshake");
    assert_eq!(recv_json(&mut ws).await["type"], "connected");
    tokio::spawn(async move {
        let mut received_frames = 0usize;
        while let Ok(Some(Ok(msg))) = timeout(Duration::from_millis(400), ws.next()).await {
            if matches!(msg, WsMsg::Text(_)) {
                received_frames += 1;
            }
        }
        received_frames
    })
}

async fn poll_group_messages(app: Arc<TestApp>, group_id: Uuid, expected_total: usize) -> Vec<i64> {
    let mut cursor = 0_i64;
    let mut seen_seqs = Vec::with_capacity(expected_total);
    let deadline = Instant::now() + Duration::from_secs(20);

    while seen_seqs.len() < expected_total && Instant::now() < deadline {
        let page: Value = app
            .client
            .get(format!(
                "{}/api/v1/groups/{group_id}/messages?after_seq={cursor}&limit=17",
                app.base_url
            ))
            .send()
            .await
            .expect("group poll http ok")
            .json()
            .await
            .expect("group poll json");

        let items = page["messages"].as_array().expect("message array");
        if items.is_empty() {
            tokio::time::sleep(Duration::from_millis(2)).await;
            continue;
        }
        for item in items {
            let seq = item["seq"].as_i64().expect("message seq");
            seen_seqs.push(seq);
            cursor = seq;
        }
    }
    seen_seqs
}

async fn spawn_storm_writers(fixture: &StormFixture) -> Vec<tokio::task::JoinHandle<()>> {
    // 24 个并发 Agent 任务通过 Barrier 同时开火：高频群消息 + 相反顺序交叉 @ + 同帖并发评论 + 并发幂等重发
    let hot_targets = [
        fixture.all_agent_ids[0],
        fixture.all_agent_ids[5],
        fixture.all_agent_ids[11],
        fixture.all_agent_ids[17],
        fixture.all_agent_ids[23],
    ];
    let barrier = Arc::new(Barrier::new(AGENT_COUNT));
    let mut handles = Vec::with_capacity(AGENT_COUNT);

    for (idx, (_agent_id, token)) in fixture.agents.iter().cloned().enumerate() {
        let app = Arc::clone(&fixture.app);
        let barrier = Arc::clone(&barrier);
        let group_id = fixture.group_id;
        let post_id = fixture.post_id;
        handles.push(tokio::spawn(run_storm_writer(
            app,
            barrier,
            token,
            idx,
            hot_targets.to_vec(),
            group_id,
            post_id,
        )));
    }
    handles
}

async fn run_storm_writer(
    app: Arc<TestApp>,
    barrier: Arc<Barrier>,
    token: String,
    idx: usize,
    hot_targets: Vec<Uuid>,
    group_id: Uuid,
    post_id: Uuid,
) {
    // 故意让奇偶任务传入完全相反顺序的同一批 @ 目标，最大化交叉行锁竞争测试无死锁保证。
    let mentions = reversed_for_odd(idx, hot_targets);
    barrier.wait().await;

    send_storm_messages(&app, group_id, &token, idx, &mentions).await;
    send_storm_comments(&app, post_id, &token, idx, &mentions).await;
}

fn reversed_for_odd(idx: usize, targets: Vec<Uuid>) -> Vec<Uuid> {
    if idx % 2 == 0 {
        targets
    } else {
        targets.into_iter().rev().collect()
    }
}

async fn send_storm_messages(
    app: &TestApp,
    group_id: Uuid,
    token: &str,
    idx: usize,
    mentions: &[Uuid],
) {
    for message_idx in 0..MSGS_PER_AGENT {
        let client_msg_id = format!("storm-g-{idx}-{message_idx}");
        let payload = json!({
            "client_msg_id": client_msg_id,
            "content": format!("Agent {idx} burst message #{message_idx} - {}", "x".repeat(12288)),
            "mention_agent_ids": mentions,
        });
        let response = post_json_response(
            app,
            &format!("/api/v1/groups/{group_id}/messages"),
            token,
            &payload,
        )
        .await;
        assert!(
            response.status().is_success(),
            "unexpected group status: {}",
            response.status()
        );

        // 每第 5 条消息顺带并发触发一次同 client_msg_id 幂等重试。
        if message_idx % 5 == 0 {
            let duplicate = post_json_response(
                app,
                &format!("/api/v1/groups/{group_id}/messages"),
                token,
                &payload,
            )
            .await;
            assert_eq!(duplicate.status(), 200);
        }
    }
}

async fn send_storm_comments(
    app: &TestApp,
    post_id: Uuid,
    token: &str,
    idx: usize,
    mentions: &[Uuid],
) {
    for comment_idx in 0..COMMENTS_PER_AGENT {
        let payload = json!({
            "client_req_id": format!("storm-c-{idx}-{comment_idx}"),
            "content": format!("Agent {idx} concurrent comment #{comment_idx}"),
            "mention_agent_ids": mentions,
        });
        let response = post_json_response(
            app,
            &format!("/api/v1/posts/{post_id}/comments"),
            token,
            &payload,
        )
        .await;
        assert_eq!(
            response.status(),
            201,
            "unexpected comment status: {}",
            response.status()
        );
    }
}

async fn post_json_response(
    app: &TestApp,
    path: &str,
    token: &str,
    payload: &Value,
) -> reqwest::Response {
    app.client
        .post(format!("{}{path}", app.base_url))
        .bearer_auth(token)
        .json(payload)
        .send()
        .await
        .expect("storm post http ok")
}

async fn assert_post_comment_pagination(app: &TestApp, post_id: Uuid, expected_total: usize) {
    let post: Value = app
        .client
        .get(format!("{}/api/v1/posts/{post_id}", app.base_url))
        .send()
        .await
        .expect("post request")
        .json()
        .await
        .expect("post json");
    assert_eq!(
        post["post"]["comment_count"].as_u64().unwrap() as usize,
        expected_total
    );

    let mut collected = HashSet::new();
    let mut comments = fetch_comments_page(app, post_id, None).await;
    loop {
        for item in comments["comments"].as_array().expect("comment array") {
            let id = parse_id(&item["id"]);
            assert!(
                collected.insert(id),
                "duplicate comment in cursor pagination"
            );
        }
        if !comments["has_more"].as_bool().expect("comment has_more") {
            break;
        }
        let cursor = comments["next_cursor"].as_str().map(str::to_owned);
        comments = fetch_comments_page(app, post_id, cursor).await;
    }
    assert_eq!(collected.len(), expected_total);
}

async fn fetch_comments_page(app: &TestApp, post_id: Uuid, cursor: Option<String>) -> Value {
    let mut url = format!("{}/api/v1/posts/{post_id}/comments?limit=35", app.base_url);
    if let Some(cursor) = cursor {
        url.push_str(&format!("&cursor={cursor}"));
    }
    app.client
        .get(url)
        .send()
        .await
        .expect("comments request")
        .json()
        .await
        .expect("comments json")
}

async fn assert_agent_inboxes(app: &TestApp, agents: &[(Uuid, String)]) {
    for (agent_id, token) in agents {
        let inbox_seqs = fetch_inbox_seqs(app, token).await;
        assert_eq!(
            inbox_seqs,
            (1..=(inbox_seqs.len() as i64)).collect::<Vec<i64>>(),
            "agent {agent_id} inbox_seq must be strictly contiguous"
        );
    }

    // 被高频交叉 @ 的目标收到所有其他 Agent 的群消息和评论通知。
    for hot_index in [0usize, 5, 11, 17, 23] {
        let (_, token) = &agents[hot_index];
        let inbox_count = fetch_inbox_seqs(app, token).await.len();
        assert_eq!(
            inbox_count,
            (AGENT_COUNT - 1) * (MSGS_PER_AGENT + COMMENTS_PER_AGENT)
        );
    }
}

async fn fetch_inbox_seqs(app: &TestApp, token: &str) -> Vec<i64> {
    let mut cursor = 0_i64;
    let mut seqs = Vec::new();
    loop {
        let page: Value = app
            .client
            .get(format!(
                "{}/api/v1/inbox?after_inbox_seq={cursor}&limit=100",
                app.base_url
            ))
            .bearer_auth(token)
            .send()
            .await
            .expect("inbox request")
            .json()
            .await
            .expect("inbox json");
        for item in page["items"].as_array().expect("inbox array") {
            let seq = item["inbox_seq"].as_i64().expect("inbox seq");
            seqs.push(seq);
            cursor = seq;
        }
        if !page["has_more"].as_bool().expect("inbox has_more") {
            break;
        }
    }
    seqs
}

async fn recover_slow_consumer(
    fixture: &StormFixture,
    slow_ws: &mut TestWs,
    recovery: &mut SlowRecovery,
    total_group_msgs: usize,
) {
    let expected_complete = |recovery: &SlowRecovery| {
        recovery.saw_group_resync
            && recovery.saw_inbox_resync
            && recovery.group_map.len() == total_group_msgs
    };
    while !expected_complete(recovery) {
        let Ok(frame) = timeout(Duration::from_millis(200), recv_json(slow_ws)).await else {
            break;
        };
        match frame["type"].as_str().unwrap_or_default() {
            "group_message" => record_live_group_frame(recovery, &frame),
            "resync_required" => {
                handle_slow_resync(fixture, recovery, &frame).await;
            }
            _ => {}
        }
    }
}

fn record_live_group_frame(recovery: &mut SlowRecovery, frame: &Value) {
    let seq = frame["message"]["seq"].as_i64().expect("live message seq");
    let id = parse_id(&frame["message"]["id"]);
    recovery.group_map.insert(seq, id);
}

async fn handle_slow_resync(fixture: &StormFixture, recovery: &mut SlowRecovery, frame: &Value) {
    match frame["scope"].as_str().unwrap_or_default() {
        "group" => {
            recovery.saw_group_resync = true;
            let messages =
                fetch_group_messages_after(&fixture.app, fixture.group_id, recovery.last_group_seq)
                    .await;
            for (seq, id) in messages {
                recovery.group_map.insert(seq, id);
                recovery.last_group_seq = seq;
            }
        }
        "inbox" => recovery.saw_inbox_resync = true,
        _ => {}
    }
}

async fn fetch_group_messages_after(
    app: &TestApp,
    group_id: Uuid,
    cursor: i64,
) -> Vec<(i64, Uuid)> {
    let mut after_seq = cursor;
    let mut messages = Vec::new();
    loop {
        let page: Value = app
            .client
            .get(format!(
                "{}/api/v1/groups/{group_id}/messages?after_seq={after_seq}&limit=100",
                app.base_url
            ))
            .send()
            .await
            .expect("resync group request")
            .json()
            .await
            .expect("resync group json");
        for item in page["messages"].as_array().expect("resync message array") {
            let seq = item["seq"].as_i64().expect("resync message seq");
            let id = parse_id(&item["id"]);
            messages.push((seq, id));
            after_seq = seq;
        }
        if !page["has_more"].as_bool().expect("resync group has_more") {
            break;
        }
    }
    messages
}

async fn assert_recovered_state(
    fixture: &StormFixture,
    recovery: SlowRecovery,
    total_group_msgs: usize,
    total_comments: usize,
) {
    assert!(
        recovery.saw_group_resync,
        "slow consumer must observe group resync_required (inbox_resync={}, map_len={})",
        recovery.saw_inbox_resync,
        recovery.group_map.len()
    );

    let recovered_inbox = fetch_inbox_seqs(&fixture.app, &fixture.agents[0].1).await;
    assert_eq!(
        recovered_inbox.len(),
        (AGENT_COUNT - 1) * (MSGS_PER_AGENT + COMMENTS_PER_AGENT)
    );
    assert_eq!(recovery.group_map.len(), total_group_msgs);
    assert_eq!(
        recovery.group_map.keys().copied().collect::<Vec<i64>>(),
        (1..=(total_group_msgs as i64)).collect::<Vec<i64>>()
    );
    assert_eq!(total_comments, AGENT_COUNT * COMMENTS_PER_AGENT);
}

async fn recv_json(ws: &mut TestWs) -> Value {
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
