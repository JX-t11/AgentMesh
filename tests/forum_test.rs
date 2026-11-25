mod common;

use std::time::Duration;

use common::{TestApp, TEST_ADMIN_TOKEN};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use uuid::Uuid;

#[tokio::test]
async fn board_creation_post_publishing_forum_stream_and_mentions() {
    let app = TestApp::spawn().await;
    let (author_id, author_token) = app
        .register_agent("author-oc", "Author OC", "openclaw")
        .await;
    let (online_target, online_token) = app
        .register_agent("online-hm", "Online Hermes", "hermes")
        .await;
    let (offline_target, offline_token) = app
        .register_agent("offline-hm", "Offline Hermes", "hermes")
        .await;

    let b_resp = app
        .client
        .post(format!("{}/api/v1/admin/boards", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "tech-talk",
            "name": "Tech Talk",
            "description": "Architecture & Rust discussions",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(b_resp.status(), 201);
    let b_json: Value = b_resp.json().await.unwrap();
    let board_id = Uuid::parse_str(b_json["board"]["id"].as_str().unwrap()).unwrap();

    let (mut obs_ws, _) = connect_async(format!("{}/api/v1/ws/observe", app.ws_base_url))
        .await
        .unwrap();
    assert_eq!(recv_json(&mut obs_ws).await["role"], "observer");
    obs_ws
        .send(WsMsg::Text(
            json!({ "action": "subscribe", "forum": true })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(recv_json(&mut obs_ws).await["type"], "subscribed");

    let mut agent_req = format!("{}/api/v1/ws/agent", app.ws_base_url)
        .into_client_request()
        .unwrap();
    agent_req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {online_token}")).unwrap(),
    );
    let (mut online_ws, _) = connect_async(agent_req).await.unwrap();
    assert_eq!(recv_json(&mut online_ws).await["type"], "connected");

    let no_board = app
        .client
        .post(format!(
            "{}/api/v1/boards/{}/posts",
            app.base_url,
            Uuid::new_v4()
        ))
        .bearer_auth(&author_token)
        .json(&json!({
            "client_req_id": "p-missing",
            "title": "Hello",
            "content": "World",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(no_board.status(), 404);

    let bad_mention = app
        .client
        .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
        .bearer_auth(&author_token)
        .json(&json!({
            "client_req_id": "p-bad-mention",
            "title": "Hello",
            "content": "World",
            "mention_agent_ids": [Uuid::new_v4()],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_mention.status(), 422);

    let post_resp = app
        .client
        .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
        .bearer_auth(&author_token)
        .json(&json!({
            "client_req_id": "p-1",
            "title": "AgentMesh High-Concurrency Proposal",
            "content": "Calling @online-hm and @offline-hm to review!",
            "mention_agent_ids": [online_target, offline_target, author_id],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(post_resp.status(), 201);
    let post_json: Value = post_resp.json().await.unwrap();
    let post_id = Uuid::parse_str(post_json["post"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(post_json["post"]["comment_count"], 0);

    let obs_ev = recv_json(&mut obs_ws).await;
    assert_eq!(obs_ev["type"], "post_created");
    assert_eq!(obs_ev["post"]["id"], post_id.to_string());

    let mention_ev = recv_json(&mut online_ws).await;
    assert_eq!(mention_ev["type"], "inbox_event");
    assert_eq!(mention_ev["event"]["kind"], "post_mention");
    assert_eq!(mention_ev["event"]["post_id"], post_id.to_string());

    let offline_inbox: Value = app
        .client
        .get(format!("{}/api/v1/inbox", app.base_url))
        .bearer_auth(&offline_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(offline_inbox["items"].as_array().unwrap().len(), 1);
    assert_eq!(offline_inbox["items"][0]["kind"], "post_mention");

    let retry_ok = app
        .client
        .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
        .bearer_auth(&author_token)
        .json(&json!({
            "client_req_id": "p-1",
            "title": "AgentMesh High-Concurrency Proposal",
            "content": "Calling @online-hm and @offline-hm to review!",
            "mention_agent_ids": [offline_target, author_id, online_target],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(retry_ok.status(), 200);

    let retry_conflict = app
        .client
        .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
        .bearer_auth(&author_token)
        .json(&json!({
            "client_req_id": "p-1",
            "title": "Different Title",
            "content": "Calling @online-hm and @offline-hm to review!",
            "mention_agent_ids": [online_target, offline_target, author_id],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(retry_conflict.status(), 409);

    app.cleanup().await;
}

#[tokio::test]
async fn comment_threading_atomic_stats_and_keyset_pagination_under_concurrent_inserts() {
    let app = TestApp::spawn().await;
    let (_post_author, token_p) = app.register_agent("poster", "Poster", "openclaw").await;
    let (_commenter_1, token_c1) = app.register_agent("c1", "Commenter 1", "hermes").await;
    let (_commenter_2, token_c2) = app.register_agent("c2", "Commenter 2", "openclaw").await;
    let (mentioned_agent, token_m) = app.register_agent("m1", "Mentioned", "hermes").await;

    let b_json: Value = app
        .client
        .post(format!("{}/api/v1/admin/boards", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({ "slug": "general", "name": "General" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let board_id = Uuid::parse_str(b_json["board"]["id"].as_str().unwrap()).unwrap();

    // 连续创建 4 篇帖子 p1..p4
    let mut post_ids = Vec::new();
    for i in 1..=4 {
        let p: Value = app
            .client
            .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
            .bearer_auth(&token_p)
            .json(&json!({
                "client_req_id": format!("post-{i}"),
                "title": format!("Post #{i}"),
                "content": format!("Body #{i}"),
            }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        post_ids.push(Uuid::parse_str(p["post"]["id"].as_str().unwrap()).unwrap());
        tokio::time::sleep(Duration::from_millis(2)).await;
    }

    let post_1 = post_ids[0];
    let post_2 = post_ids[1];

    // 1. Keyset 分页稳定性验证（newest 模式）：
    // 先取第 1 页（limit=2，拿到 post_4, post_3 及 next_cursor），然后在顶部新插入 post_5，再用 next_cursor 取第 2 页
    let page_1: Value = app
        .client
        .get(format!(
            "{}/api/v1/boards/{board_id}/posts?sort=newest&limit=2",
            app.base_url
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let p1_ids: Vec<Uuid> = page_1["posts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| Uuid::parse_str(v["id"].as_str().unwrap()).unwrap())
        .collect();
    assert_eq!(p1_ids, vec![post_ids[3], post_ids[2]]);
    let cursor = page_1["next_cursor"].as_str().unwrap().to_owned();

    // 并发插入新帖 post_5
    let p5_resp = app
        .client
        .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
        .bearer_auth(&token_p)
        .json(&json!({
            "client_req_id": "post-5",
            "title": "Post #5 Concurrent",
            "content": "Inserted while paginating",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(p5_resp.status(), 201);

    // 继续用刚才的 next_cursor 翻第 2 页，必须精确返回 post_2, post_1，无重复无遗漏
    let page_2: Value = app
        .client
        .get(format!(
            "{}/api/v1/boards/{board_id}/posts?sort=newest&limit=2&cursor={cursor}",
            app.base_url
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let p2_ids: Vec<Uuid> = page_2["posts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| Uuid::parse_str(v["id"].as_str().unwrap()).unwrap())
        .collect();
    assert_eq!(p2_ids, vec![post_ids[1], post_ids[0]]);
    assert_eq!(page_2["has_more"], false);

    // 2. 评论盖楼与跨帖父评论拦截：
    // 先在 post_2 发一条评论，尝试在 post_1 里把 post_2 的评论当作 parent_comment_id -> 422 拦截且计数仍为 0
    let c_on_p2: Value = app
        .client
        .post(format!("{}/api/v1/posts/{post_2}/comments", app.base_url))
        .bearer_auth(&token_c1)
        .json(&json!({
            "client_req_id": "c-p2-1",
            "content": "Comment on post 2",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let p2_comment_id = Uuid::parse_str(c_on_p2["comment"]["id"].as_str().unwrap()).unwrap();

    let cross_parent = app
        .client
        .post(format!("{}/api/v1/posts/{post_1}/comments", app.base_url))
        .bearer_auth(&token_c2)
        .json(&json!({
            "client_req_id": "c-bad-parent",
            "content": "Wrong parent post",
            "parent_comment_id": p2_comment_id,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(cross_parent.status(), 422);

    let p1_check: Value = app
        .client
        .get(format!("{}/api/v1/posts/{post_1}", app.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(p1_check["post"]["comment_count"], 0);

    // 3. 在最老的 post_1 下发一层楼 c1，再由 c2 回复 c1 并 @mentioned_agent
    let c1_resp = app
        .client
        .post(format!("{}/api/v1/posts/{post_1}/comments", app.base_url))
        .bearer_auth(&token_c1)
        .json(&json!({
            "client_req_id": "p1-c1",
            "content": "First floor on post 1",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(c1_resp.status(), 201);
    let c1_json: Value = c1_resp.json().await.unwrap();
    assert_eq!(c1_json["post_comment_count"], 1);
    let c1_id = Uuid::parse_str(c1_json["comment"]["id"].as_str().unwrap()).unwrap();

    let c2_resp = app
        .client
        .post(format!("{}/api/v1/posts/{post_1}/comments", app.base_url))
        .bearer_auth(&token_c2)
        .json(&json!({
            "client_req_id": "p1-c2",
            "content": "Second floor replying to c1 and calling @m1",
            "parent_comment_id": c1_id,
            "mention_agent_ids": [mentioned_agent],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(c2_resp.status(), 201);
    let c2_json: Value = c2_resp.json().await.unwrap();
    assert_eq!(c2_json["post_comment_count"], 2);

    // 幂等重试不重复增加 comment_count
    let c2_retry: Value = app
        .client
        .post(format!("{}/api/v1/posts/{post_1}/comments", app.base_url))
        .bearer_auth(&token_c2)
        .json(&json!({
            "client_req_id": "p1-c2",
            "content": "Second floor replying to c1 and calling @m1",
            "parent_comment_id": c1_id,
            "mention_agent_ids": [mentioned_agent],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(c2_retry["post_comment_count"], 2);

    // 验证 post_1 因最新评论活跃，在 sort=active 下已被顶到板块第 1 位！
    let active_list: Value = app
        .client
        .get(format!(
            "{}/api/v1/boards/{board_id}/posts?sort=active&limit=1",
            app.base_url
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(active_list["posts"][0]["id"], post_1.to_string());
    assert_eq!(active_list["posts"][0]["comment_count"], 2);

    // 验证三种定向通知准确送达：楼主收到 post_reply（post_2 上 1 条 + post_1 上 2 条 = 共 3 条），c1 收到 comment_reply（1 条），m1 收到 comment_mention（1 条）
    let p_inbox: Value = app
        .client
        .get(format!("{}/api/v1/inbox", app.base_url))
        .bearer_auth(&token_p)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(p_inbox["items"].as_array().unwrap().len(), 3);
    assert_eq!(p_inbox["items"][0]["post_id"], post_2.to_string());
    assert_eq!(p_inbox["items"][1]["post_id"], post_1.to_string());
    assert_eq!(p_inbox["items"][2]["post_id"], post_1.to_string());
    assert_eq!(p_inbox["items"][0]["kind"], "post_reply");

    let c1_inbox: Value = app
        .client
        .get(format!("{}/api/v1/inbox", app.base_url))
        .bearer_auth(&token_c1)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(c1_inbox["items"].as_array().unwrap().len(), 1);
    assert_eq!(c1_inbox["items"][0]["kind"], "comment_reply");

    let m_inbox: Value = app
        .client
        .get(format!("{}/api/v1/inbox", app.base_url))
        .bearer_auth(&token_m)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(m_inbox["items"].as_array().unwrap().len(), 1);
    assert_eq!(m_inbox["items"][0]["kind"], "comment_mention");

    // 4. 单帖评论列表正序 Keyset 游标分页
    let cm_page1: Value = app
        .client
        .get(format!(
            "{}/api/v1/posts/{post_1}/comments?limit=1",
            app.base_url
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(cm_page1["comments"][0]["id"], c1_id.to_string());
    let cm_cursor = cm_page1["next_cursor"].as_str().unwrap();

    let cm_page2: Value = app
        .client
        .get(format!(
            "{}/api/v1/posts/{post_1}/comments?limit=1&cursor={cm_cursor}",
            app.base_url
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        cm_page2["comments"][0]["parent_comment_id"],
        c1_id.to_string()
    );
    assert_eq!(cm_page2["has_more"], false);

    app.cleanup().await;
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

#[tokio::test]
async fn duplicate_client_req_id_replays_posts_and_conflicts_on_different_payloads() {
    let app = TestApp::spawn().await;
    let (_author_id, author_token) = app
        .register_agent("forum-idem", "Forum Idem", "openclaw")
        .await;

    let b_resp = app
        .client
        .post(format!("{}/api/v1/admin/boards", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({"slug": "idem-board", "name": "Idem Board"}))
        .send()
        .await
        .unwrap();
    assert_eq!(b_resp.status(), 201);
    let board_id = Uuid::parse_str(
        b_resp.json::<Value>().await.unwrap()["board"]["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap();

    let create_post = |req_id: &'static str, title: &'static str, content: &'static str| {
        let app = &app;
        let author_token = &author_token;
        async move {
            let response = app
                .client
                .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
                .bearer_auth(author_token)
                .json(&json!({
                    "client_req_id": req_id,
                    "title": title,
                    "content": content,
                }))
                .send()
                .await
                .unwrap();
            let status = response.status().as_u16();
            (status, response.json::<Value>().await.unwrap())
        }
    };

    let (first_status, first) = create_post("idem-req-1", "RFC draft", "First content").await;
    assert_eq!(first_status, 201);
    let post_id = first["post"]["id"].as_str().unwrap().to_owned();

    let (replay_status, replay) = create_post("idem-req-1", "RFC draft", "First content").await;
    assert_eq!(replay_status, 200);
    assert_eq!(replay["post"]["id"].as_str().unwrap(), post_id);

    let (conflict_status, conflict) =
        create_post("idem-req-1", "RFC draft", "Different body").await;
    assert_eq!(conflict_status, 409);
    assert_eq!(conflict["error"]["code"], "conflict");

    let create_comment = |req_id: &'static str, content: &'static str| {
        let app = &app;
        let author_token = &author_token;
        let post_path = format!("{}/api/v1/posts/{post_id}/comments", app.base_url);
        async move {
            let response = app
                .client
                .post(post_path)
                .bearer_auth(author_token)
                .json(&json!({"client_req_id": req_id, "content": content}))
                .send()
                .await
                .unwrap();
            let status = response.status().as_u16();
            (status, response.json::<Value>().await.unwrap())
        }
    };

    let (first_status, first_comment) = create_comment("idem-comment-1", "Looks good").await;
    assert_eq!(first_status, 201);
    let comment_id = first_comment["comment"]["id"].as_str().unwrap().to_owned();

    let (replay_status, replay_comment) = create_comment("idem-comment-1", "Looks good").await;
    assert_eq!(replay_status, 200);
    assert_eq!(
        replay_comment["comment"]["id"].as_str().unwrap(),
        comment_id
    );

    let (conflict_status, conflict_comment) =
        create_comment("idem-comment-1", "Changed mind").await;
    assert_eq!(conflict_status, 409);
    assert_eq!(conflict_comment["error"]["code"], "conflict");

    app.cleanup().await;
}
