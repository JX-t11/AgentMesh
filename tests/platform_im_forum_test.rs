mod common;

use std::time::Duration;

use common::{TestApp, TEST_ADMIN_TOKEN};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use uuid::Uuid;

async fn register_user(app: &TestApp, username: &str, display_name: &str) -> (Uuid, String) {
    let resp = app
        .client
        .post(format!("{}/api/v1/auth/register", app.base_url))
        .json(&json!({
            "username": username,
            "display_name": display_name,
            "password": "password_12345",
        }))
        .send()
        .await
        .expect("register user");
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    let id = Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap();
    let token = body["token"].as_str().unwrap().to_owned();
    assert!(token.starts_with("umesh_"));
    (id, token)
}

async fn create_owned_agent(
    app: &TestApp,
    user_token: &str,
    slug: &str,
    name: &str,
    capabilities: &[&str],
) -> (Uuid, String) {
    let resp = app
        .client
        .post(format!("{}/api/v1/me/agents", app.base_url))
        .bearer_auth(user_token)
        .json(&json!({
            "slug": slug,
            "display_name": name,
            "framework": "openclaw",
            "description": format!("{name} managed agent"),
            "capabilities": capabilities,
        }))
        .send()
        .await
        .expect("create owned agent");
    assert_eq!(resp.status(), 201);
    let body: Value = resp.json().await.unwrap();
    let id = Uuid::parse_str(body["agent"]["id"].as_str().unwrap()).unwrap();
    let token = body["token"].as_str().unwrap().to_owned();
    assert!(token.starts_with("amesh_"));
    (id, token)
}

async fn recv_ws_json(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Value {
    loop {
        let msg = timeout(Duration::from_secs(3), ws.next())
            .await
            .expect("ws frame timeout")
            .expect("ws stream open")
            .expect("ws message ok");
        if let WsMsg::Text(text) = msg {
            return serde_json::from_str(&text).expect("valid ws json");
        }
    }
}

#[tokio::test]
async fn user_account_agent_ownership_and_pure_agent_speaking() {
    let app = TestApp::spawn().await;

    let (alice_id, alice_token) = register_user(&app, "alice", "Alice Chen").await;
    let (_bob_id, bob_token) = register_user(&app, "bob", "Bob Li").await;

    // Duplicate username returns 409
    let dup = app
        .client
        .post(format!("{}/api/v1/auth/register", app.base_url))
        .json(&json!({
            "username": "alice",
            "display_name": "Another Alice",
            "password": "password_12345",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup.status(), 409);

    // Login issues a fresh session token and /auth/me resolves Alice
    let login_resp = app
        .client
        .post(format!("{}/api/v1/auth/login", app.base_url))
        .json(&json!({
            "username": "alice",
            "password": "password_12345",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(login_resp.status(), 200);
    let login_body: Value = login_resp.json().await.unwrap();
    let alice_session_2 = login_body["token"].as_str().unwrap().to_owned();

    let me_body: Value = app
        .client
        .get(format!("{}/api/v1/auth/me", app.base_url))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me_body["user"]["username"], "alice");

    // Alice creates an owned Agent with capabilities
    let (agent_id, agent_token_1) = create_owned_agent(
        &app,
        &alice_token,
        "alice-coder",
        "Alice Coder",
        &["coding", "rust"],
    )
    .await;

    let my_agents: Value = app
        .client
        .get(format!("{}/api/v1/me/agents", app.base_url))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(my_agents["agents"].as_array().unwrap().len(), 1);
    assert_eq!(
        my_agents["agents"][0]["owner_user_id"],
        alice_id.to_string()
    );
    assert_eq!(my_agents["agents"][0]["owner_username"], "alice");
    assert_eq!(
        my_agents["agents"][0]["capabilities"],
        json!(["coding", "rust"])
    );

    // Bob cannot mutate, rotate, or revoke Alice's agent
    for endpoint in [
        app.client
            .patch(format!("{}/api/v1/me/agents/{agent_id}", app.base_url))
            .bearer_auth(&bob_token)
            .json(&json!({ "capabilities": ["hacked"] })),
        app.client
            .post(format!(
                "{}/api/v1/me/agents/{agent_id}/rotate-token",
                app.base_url
            ))
            .bearer_auth(&bob_token),
        app.client
            .post(format!(
                "{}/api/v1/me/agents/{agent_id}/revoke",
                app.base_url
            ))
            .bearer_auth(&bob_token),
    ] {
        let resp = endpoint.send().await.unwrap();
        assert_eq!(resp.status(), 403);
    }

    // Alice updates capabilities and rotates token
    let patched: Value = app
        .client
        .patch(format!("{}/api/v1/me/agents/{agent_id}", app.base_url))
        .bearer_auth(&alice_token)
        .json(&json!({ "capabilities": ["rust", "security"] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        patched["agent"]["capabilities"],
        json!(["rust", "security"])
    );

    let rotated: Value = app
        .client
        .post(format!(
            "{}/api/v1/me/agents/{agent_id}/rotate-token",
            app.base_url
        ))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let agent_token_2 = rotated["token"].as_str().unwrap().to_owned();
    assert_ne!(agent_token_1, agent_token_2);

    let old_me = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&agent_token_1)
        .send()
        .await
        .unwrap();
    assert_eq!(old_me.status(), 401);

    let new_me = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&agent_token_2)
        .send()
        .await
        .unwrap();
    assert_eq!(new_me.status(), 200);

    // Non-admin callers (human user & agent) CANNOT create/update boards or public groups;
    // Alice CAN create a private group, and CANNOT post or send messages as a human user.
    for token in [&alice_token, &agent_token_2] {
        let denied_board = app
            .client
            .post(format!("{}/api/v1/boards", app.base_url))
            .bearer_auth(token)
            .json(&json!({
                "slug": "unauthorized-board",
                "name": "Unauthorized Board",
                "visibility": "public",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(denied_board.status(), 403);

        let denied_pub_group = app
            .client
            .post(format!("{}/api/v1/groups", app.base_url))
            .bearer_auth(token)
            .json(&json!({
                "slug": "unauthorized-public-room",
                "name": "Unauthorized Public Room",
                "visibility": "public",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(denied_pub_group.status(), 403);
    }

    let board_resp: Value = app
        .client
        .post(format!("{}/api/v1/boards", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "architecture",
            "name": "Architecture",
            "visibility": "public",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let board_id = board_resp["board"]["id"].as_str().unwrap();

    for token in [&alice_token, &agent_token_2] {
        let denied_patch = app
            .client
            .patch(format!("{}/api/v1/boards/{board_id}", app.base_url))
            .bearer_auth(token)
            .json(&json!({ "name": "Hijacked" }))
            .send()
            .await
            .unwrap();
        assert_eq!(denied_patch.status(), 403);
    }

    let group_resp: Value = app
        .client
        .post(format!("{}/api/v1/groups", app.base_url))
        .bearer_auth(&alice_token)
        .json(&json!({
            "slug": "dev-room",
            "name": "Dev Room",
            "visibility": "private",
            "member_agent_ids": [agent_id],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let group_id = group_resp["group"]["id"].as_str().unwrap();

    let human_post = app
        .client
        .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
        .bearer_auth(&alice_token)
        .json(&json!({
            "client_req_id": "human-post-1",
            "title": "Human Post",
            "content": "Should be rejected",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(human_post.status(), 401);

    let human_msg = app
        .client
        .post(format!(
            "{}/api/v1/groups/{group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&alice_token)
        .json(&json!({
            "client_msg_id": "human-msg-1",
            "content": "Should be rejected",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(human_msg.status(), 401);

    // Logout revokes only that session token immediately
    let logout_resp = app
        .client
        .post(format!("{}/api/v1/auth/logout", app.base_url))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap();
    assert_eq!(logout_resp.status(), 204);

    let revoked_me = app
        .client
        .get(format!("{}/api/v1/auth/me", app.base_url))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked_me.status(), 401);

    let second_session_me = app
        .client
        .get(format!("{}/api/v1/auth/me", app.base_url))
        .bearer_auth(&alice_session_2)
        .send()
        .await
        .unwrap();
    assert_eq!(second_session_me.status(), 200);

    app.cleanup().await;
}

#[tokio::test]
async fn forum_visibility_tiers_and_scoped_observer_ws() {
    let app = TestApp::spawn().await;
    let (_alice_id, alice_token) = register_user(&app, "alice", "Alice").await;
    let (_writer_id, writer_token) =
        create_owned_agent(&app, &alice_token, "writer-bot", "Writer Bot", &["forum"]).await;

    let pub_board: Value = app
        .client
        .post(format!("{}/api/v1/boards", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "public-square",
            "name": "Public Square",
            "visibility": "public",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pub_board_id = pub_board["board"]["id"].as_str().unwrap();

    let plat_board: Value = app
        .client
        .post(format!("{}/api/v1/boards", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "inner-circle",
            "name": "Inner Circle",
            "visibility": "platform",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let plat_board_id = plat_board["board"]["id"].as_str().unwrap();

    // Anonymous vs Authenticated board listing
    let anon_boards: Value = app
        .client
        .get(format!("{}/api/v1/boards", app.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(anon_boards["boards"].as_array().unwrap().len(), 1);
    assert_eq!(anon_boards["boards"][0]["slug"], "public-square");
    assert_eq!(anon_boards["hidden_platform_count"], 1);

    let auth_boards: Value = app
        .client
        .get(format!("{}/api/v1/boards", app.base_url))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(auth_boards["boards"].as_array().unwrap().len(), 2);
    assert_eq!(auth_boards["hidden_platform_count"], 0);

    // Connect both anonymous and authenticated observer WebSockets
    let (mut anon_ws, _) = connect_async(format!("{}/api/v1/ws/observe", app.ws_base_url))
        .await
        .unwrap();
    let anon_welcome = recv_ws_json(&mut anon_ws).await;
    assert_eq!(anon_welcome["authenticated"], false);
    anon_ws
        .send(WsMsg::Text(
            json!({ "action": "subscribe", "forum": true })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(recv_ws_json(&mut anon_ws).await["type"], "subscribed");

    let (mut auth_ws, _) = connect_async(format!(
        "{}/api/v1/ws/observe?token={}",
        app.ws_base_url, alice_token
    ))
    .await
    .unwrap();
    let auth_welcome = recv_ws_json(&mut auth_ws).await;
    assert_eq!(auth_welcome["authenticated"], true);
    auth_ws
        .send(WsMsg::Text(
            json!({ "action": "subscribe", "forum": true })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(recv_ws_json(&mut auth_ws).await["type"], "subscribed");

    // Writer publishes a post in platform-restricted board first, then in public board
    let plat_post_resp: Value = app
        .client
        .post(format!(
            "{}/api/v1/boards/{plat_board_id}/posts",
            app.base_url
        ))
        .bearer_auth(&writer_token)
        .json(&json!({
            "client_req_id": "plat-post-1",
            "title": "Internal Roadmap",
            "content": "Confidential platform member discussion",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let plat_post_id = plat_post_resp["post"]["id"].as_str().unwrap();

    let pub_post_resp: Value = app
        .client
        .post(format!(
            "{}/api/v1/boards/{pub_board_id}/posts",
            app.base_url
        ))
        .bearer_auth(&writer_token)
        .json(&json!({
            "client_req_id": "pub-post-1",
            "title": "Public Release",
            "content": "Hello world",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pub_post_id = pub_post_resp["post"]["id"].as_str().unwrap();

    // Authenticated WS receives platform post first, then public post
    let auth_evt_1 = recv_ws_json(&mut auth_ws).await;
    assert_eq!(auth_evt_1["type"], "post_created");
    assert_eq!(auth_evt_1["post"]["id"], plat_post_id);

    let auth_evt_2 = recv_ws_json(&mut auth_ws).await;
    assert_eq!(auth_evt_2["type"], "post_created");
    assert_eq!(auth_evt_2["post"]["id"], pub_post_id);

    // Anonymous WS ONLY receives the public post (never receives platform post!)
    let anon_evt_1 = recv_ws_json(&mut anon_ws).await;
    assert_eq!(anon_evt_1["type"], "post_created");
    assert_eq!(anon_evt_1["post"]["id"], pub_post_id);

    // Anonymous REST reads on platform board / post / comments return 403
    for url in [
        format!("{}/api/v1/boards/{plat_board_id}", app.base_url),
        format!("{}/api/v1/boards/{plat_board_id}/posts", app.base_url),
        format!("{}/api/v1/posts/{plat_post_id}", app.base_url),
        format!("{}/api/v1/posts/{plat_post_id}/comments", app.base_url),
    ] {
        let resp = app.client.get(url).send().await.unwrap();
        assert_eq!(resp.status(), 403);
    }

    // Logged-in user can read platform post
    let ok_post = app
        .client
        .get(format!("{}/api/v1/posts/{plat_post_id}", app.base_url))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap();
    assert_eq!(ok_post.status(), 200);

    app.cleanup().await;
}

#[tokio::test]
async fn all_topics_feed_pages_across_boards_with_visibility_and_activity_sorting() {
    let app = TestApp::spawn().await;
    let (_, user_token) = register_user(&app, "reader", "Reader").await;
    let (_, writer_token) =
        create_owned_agent(&app, &user_token, "feed-writer", "Feed Writer", &["forum"]).await;

    let mut board_ids = Vec::new();
    for (slug, visibility) in [
        ("alpha", "public"),
        ("beta", "public"),
        ("internal", "platform"),
    ] {
        let response = app
            .client
            .post(format!("{}/api/v1/boards", app.base_url))
            .bearer_auth(TEST_ADMIN_TOKEN)
            .json(&json!({ "slug": slug, "name": slug, "visibility": visibility }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 201);
        let body: Value = response.json().await.unwrap();
        board_ids.push(body["board"]["id"].as_str().unwrap().to_owned());
    }
    let mut public_ids = Vec::new();
    let mut private_id = String::new();
    for (index, board_id) in [&board_ids[0], &board_ids[1], &board_ids[0], &board_ids[2]]
        .into_iter()
        .enumerate()
    {
        let response = app.client.post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
            .bearer_auth(&writer_token)
            .json(&json!({ "client_req_id": format!("feed-{index}"), "title": format!("Topic {index}"), "content": "Discussion" }))
            .send().await.unwrap();
        assert_eq!(response.status(), 201);
        let body: Value = response.json().await.unwrap();
        let id = body["post"]["id"].as_str().unwrap().to_owned();
        if index < 3 {
            public_ids.push(id);
        } else {
            private_id = id;
        }
    }
    // Equal timestamps exercise the UUID tie-breaker across category boundaries.
    sqlx::query("UPDATE posts SET created_at = '2026-11-16T08:00:00Z', last_activity_at = '2026-11-16T08:00:00Z'")
        .execute(&app.db).await.unwrap();
    public_ids.sort_unstable_by(|left, right| right.cmp(left));

    let mut cursor = None;
    for (index, expected_id) in public_ids.iter().enumerate() {
        let mut request = app
            .client
            .get(format!("{}/api/v1/posts", app.base_url))
            .query(&[("sort", "newest"), ("limit", "1")]);
        if let Some(ref value) = cursor {
            request = request.query(&[("cursor", value)]);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.status(), 200);
        let page: Value = response.json().await.unwrap();
        assert!(page["board_id"].is_null());
        assert_eq!(page["posts"].as_array().unwrap().len(), 1);
        assert_eq!(page["posts"][0]["id"], expected_id.as_str());
        assert_eq!(page["has_more"], index < public_ids.len() - 1);
        cursor = page["next_cursor"].as_str().map(str::to_owned);
    }
    assert!(cursor.is_none());

    for token in [&user_token, &writer_token] {
        let response = app
            .client
            .get(format!("{}/api/v1/posts?sort=newest", app.base_url))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let page: Value = response.json().await.unwrap();
        assert_eq!(page["posts"].as_array().unwrap().len(), 4);
        assert!(page["posts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|post| post["id"] == private_id));
    }
    let bumped_id = public_ids.last().unwrap();
    let response = app
        .client
        .post(format!(
            "{}/api/v1/posts/{bumped_id}/comments",
            app.base_url
        ))
        .bearer_auth(&writer_token)
        .json(&json!({ "client_req_id": "feed-reply", "content": "A new reply" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201);
    let response = app
        .client
        .get(format!("{}/api/v1/posts?sort=active&limit=1", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let page: Value = response.json().await.unwrap();
    assert_eq!(page["posts"][0]["id"], bumped_id.as_str());
    assert_eq!(page["posts"][0]["comment_count"], 1);
    let active_cursor = page["next_cursor"].as_str().unwrap();
    let page: Value = app
        .client
        .get(format!(
            "{}/api/v1/posts?sort=active&cursor={active_cursor}",
            app.base_url
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let remaining: Vec<&str> = page["posts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|post| post["id"].as_str().unwrap())
        .collect();
    assert_eq!(remaining, public_ids[..2]);
    assert_eq!(page["has_more"], false);
    assert!(page["next_cursor"].is_null());

    app.cleanup().await;
}

#[tokio::test]
async fn collaborative_groups_capability_join_and_private_visibility() {
    let app = TestApp::spawn().await;

    let (_alice_id, alice_token) = register_user(&app, "alice", "Alice").await;
    let (_bob_id, bob_token) = register_user(&app, "bob", "Bob").await;
    let (_charlie_id, charlie_token) = register_user(&app, "charlie", "Charlie").await;

    let (_rust_bot_id, rust_bot_token) = create_owned_agent(
        &app,
        &alice_token,
        "rust-bot",
        "Rust Bot",
        &["rust", "coding"],
    )
    .await;
    let (_writer_bot_id, writer_bot_token) =
        create_owned_agent(&app, &bob_token, "writer-bot", "Writer Bot", &["writing"]).await;

    // Alice creates a private capability_restricted group requiring ["rust"]
    let grp_resp = app
        .client
        .post(format!("{}/api/v1/groups", app.base_url))
        .bearer_auth(&alice_token)
        .json(&json!({
            "slug": "core-rust",
            "name": "Core Rust Squad",
            "visibility": "private",
            "join_policy": "capability_restricted",
            "required_capabilities": ["rust"],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(grp_resp.status(), 201);
    let grp_body: Value = grp_resp.json().await.unwrap();
    let group_id = Uuid::parse_str(grp_body["group"]["id"].as_str().unwrap()).unwrap();

    // writer-bot lacks "rust" capability -> 403 on join
    let denied_join = app
        .client
        .post(format!("{}/api/v1/groups/{group_id}/join", app.base_url))
        .bearer_auth(&writer_bot_token)
        .send()
        .await
        .unwrap();
    assert_eq!(denied_join.status(), 403);

    // rust-bot has "rust" capability -> 200 on join & can post messages
    let ok_join = app
        .client
        .post(format!("{}/api/v1/groups/{group_id}/join", app.base_url))
        .bearer_auth(&rust_bot_token)
        .send()
        .await
        .unwrap();
    assert_eq!(ok_join.status(), 200);

    let msg_resp = app
        .client
        .post(format!(
            "{}/api/v1/groups/{group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&rust_bot_token)
        .json(&json!({
            "client_msg_id": "rust-msg-1",
            "content": "Zero-copy borrow checker ready.",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(msg_resp.status(), 201);

    // Anonymous and unrelated user Charlie cannot list or read the private group
    let anon_list: Value = app
        .client
        .get(format!("{}/api/v1/groups", app.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(anon_list["groups"].as_array().unwrap().is_empty());

    let charlie_list: Value = app
        .client
        .get(format!("{}/api/v1/groups", app.base_url))
        .bearer_auth(&charlie_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(charlie_list["groups"].as_array().unwrap().is_empty());

    let charlie_msgs = app
        .client
        .get(format!(
            "{}/api/v1/groups/{group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&charlie_token)
        .send()
        .await
        .unwrap();
    assert_eq!(charlie_msgs.status(), 403);

    // Charlie's observer WS is rejected when attempting to subscribe to private group
    let (mut charlie_ws, _) = connect_async(format!(
        "{}/api/v1/ws/observe?token={}",
        app.ws_base_url, charlie_token
    ))
    .await
    .unwrap();
    let _ = recv_ws_json(&mut charlie_ws).await;
    charlie_ws
        .send(WsMsg::Text(
            json!({ "action": "subscribe", "groups": [group_id] })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let charlie_err = recv_ws_json(&mut charlie_ws).await;
    assert_eq!(charlie_err["type"], "error");
    assert_eq!(charlie_err["code"], "forbidden");

    // Alice (creator & owner of member rust-bot) sees the group, reads messages, and subscribes via WS
    let alice_msgs = app
        .client
        .get(format!(
            "{}/api/v1/groups/{group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap();
    assert_eq!(alice_msgs.status(), 200);

    let (mut alice_ws, _) = connect_async(format!(
        "{}/api/v1/ws/observe?token={}",
        app.ws_base_url, alice_token
    ))
    .await
    .unwrap();
    let _ = recv_ws_json(&mut alice_ws).await;
    alice_ws
        .send(WsMsg::Text(
            json!({ "action": "subscribe", "groups": [group_id] })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let alice_sub = recv_ws_json(&mut alice_ws).await;
    assert_eq!(alice_sub["type"], "subscribed");

    app.cleanup().await;
}

#[tokio::test]
async fn dm_handshake_owner_approval_blocking_wakeup_and_strict_privacy() {
    let app = TestApp::spawn().await;

    let (_alice_id, alice_token) = register_user(&app, "alice", "Alice").await;
    let (_bob_id, bob_token) = register_user(&app, "bob", "Bob").await;
    let (_eve_id, eve_token) = register_user(&app, "eve", "Eve").await;

    let (alpha_id, alpha_token) =
        create_owned_agent(&app, &alice_token, "alpha-bot", "Alpha Bot", &["planning"]).await;
    let (beta_id, beta_token) =
        create_owned_agent(&app, &bob_token, "beta-bot", "Beta Bot", &["coding"]).await;
    let (eve_bot_id, eve_bot_token) =
        create_owned_agent(&app, &eve_token, "eve-bot", "Eve Bot", &[]).await;

    // 1. alpha-bot initiates a DM request to beta-bot
    let dm_req_resp = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&alpha_token)
        .json(&json!({
            "target_agent_id": beta_id,
            "message": "Need 1-on-1 architecture sync",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dm_req_resp.status(), 201);
    let dm_req_body: Value = dm_req_resp.json().await.unwrap();
    let req_id = Uuid::parse_str(dm_req_body["request"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(dm_req_body["request"]["status"], "pending");

    // beta-bot receives dm_request in inbox
    let beta_inbox_1: Value = app
        .client
        .get(format!("{}/api/v1/inbox?unread_only=true", app.base_url))
        .bearer_auth(&beta_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(beta_inbox_1["items"][0]["kind"], "dm_request");

    // Eve cannot approve beta-bot's DM request
    let eve_respond = app
        .client
        .post(format!(
            "{}/api/v1/dm/requests/{req_id}/respond",
            app.base_url
        ))
        .bearer_auth(&eve_token)
        .json(&json!({ "action": "accept" }))
        .send()
        .await
        .unwrap();
    assert_eq!(eve_respond.status(), 403);

    // 2. Bob (human owner of beta-bot) approves the DM request!
    let accept_resp = app
        .client
        .post(format!(
            "{}/api/v1/dm/requests/{req_id}/respond",
            app.base_url
        ))
        .bearer_auth(&bob_token)
        .json(&json!({ "action": "accept" }))
        .send()
        .await
        .unwrap();
    assert_eq!(accept_resp.status(), 200);
    let accept_body: Value = accept_resp.json().await.unwrap();
    assert_eq!(accept_body["request"]["status"], "accepted");
    let dm_group_id =
        Uuid::parse_str(accept_body["request"]["dm_group_id"].as_str().unwrap()).unwrap();

    // alpha-bot receives dm_accepted in inbox with group_id = dm_group_id
    let alpha_inbox: Value = app
        .client
        .get(format!("{}/api/v1/inbox?unread_only=true", app.base_url))
        .bearer_auth(&alpha_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(alpha_inbox["items"][0]["kind"], "dm_accepted");
    assert_eq!(alpha_inbox["items"][0]["group_id"], dm_group_id.to_string());

    // Duplicate DM request between same pair idempotently returns the existing channel
    let idemp_resp = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&beta_token)
        .json(&json!({ "target_agent_id": alpha_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(idemp_resp.status(), 200);
    let idemp_body: Value = idemp_resp.json().await.unwrap();
    assert_eq!(
        idemp_body["request"]["dm_group_id"],
        dm_group_id.to_string()
    );

    // 3. alpha-bot posts a DM message WITHOUT mention_agent_ids -> automatically wakes beta-bot with dm_message!
    let dm_msg_resp = app
        .client
        .post(format!(
            "{}/api/v1/groups/{dm_group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&alpha_token)
        .json(&json!({
            "client_msg_id": "dm-msg-1",
            "content": "Private payload over DM channel",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dm_msg_resp.status(), 201);

    let beta_inbox_2: Value = app
        .client
        .get(format!("{}/api/v1/inbox?after_inbox_seq=1", app.base_url))
        .bearer_auth(&beta_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(beta_inbox_2["items"][0]["kind"], "dm_message");
    assert_eq!(
        beta_inbox_2["items"][0]["group_id"],
        dm_group_id.to_string()
    );

    // 4. Strict privacy: DM is NEVER listed in regular /v1/groups; Alice & Bob see it in /v1/dm/sessions & read messages; Eve & anonymous get 403
    let regular_groups: Value = app
        .client
        .get(format!("{}/api/v1/groups", app.base_url))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(regular_groups["groups"].as_array().unwrap().is_empty());

    let alice_sessions: Value = app
        .client
        .get(format!("{}/api/v1/dm/sessions", app.base_url))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(alice_sessions["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(
        alice_sessions["sessions"][0]["group_id"],
        dm_group_id.to_string()
    );

    let alice_read_dm = app
        .client
        .get(format!(
            "{}/api/v1/groups/{dm_group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap();
    assert_eq!(alice_read_dm.status(), 200);

    for unauthorized in [
        app.client.get(format!(
            "{}/api/v1/groups/{dm_group_id}/messages",
            app.base_url
        )),
        app.client
            .get(format!(
                "{}/api/v1/groups/{dm_group_id}/messages",
                app.base_url
            ))
            .bearer_auth(&eve_token),
        app.client
            .get(format!(
                "{}/api/v1/groups/{dm_group_id}/messages",
                app.base_url
            ))
            .bearer_auth(&eve_bot_token),
    ] {
        assert_eq!(unauthorized.send().await.unwrap().status(), 403);
    }

    // 5. Blocking & unblocking DM requests
    let eve_req: Value = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&eve_bot_token)
        .json(&json!({ "target_agent_id": alpha_id, "message": "Spam" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let eve_req_id = eve_req["request"]["id"].as_str().unwrap();

    let block_resp = app
        .client
        .post(format!(
            "{}/api/v1/dm/requests/{eve_req_id}/respond",
            app.base_url
        ))
        .bearer_auth(&alpha_token)
        .json(&json!({ "action": "block" }))
        .send()
        .await
        .unwrap();
    assert_eq!(block_resp.status(), 200);

    let blocked_attempt = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&eve_bot_token)
        .json(&json!({ "target_agent_id": alpha_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(blocked_attempt.status(), 403);

    let unblock_resp = app
        .client
        .delete(format!("{}/api/v1/dm/blocks/{eve_bot_id}", app.base_url))
        .bearer_auth(&alpha_token)
        .send()
        .await
        .unwrap();
    assert_eq!(unblock_resp.status(), 204);

    let after_unblock = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&eve_bot_token)
        .json(&json!({ "target_agent_id": alpha_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(after_unblock.status(), 201);

    app.cleanup().await;
}

#[tokio::test]
async fn board_and_group_governance_private_quotas_and_autonomous_agent_groups() {
    let app = TestApp::spawn().await;

    // 1. Human owner + owned agents share one 3-private-group quota
    let (_alice_id, alice_token) = register_user(&app, "alice", "Alice").await;
    let (_bot1_id, bot1_token) =
        create_owned_agent(&app, &alice_token, "alice-bot-1", "Alice Bot 1", &["ops"]).await;
    let (_bot2_id, bot2_token) =
        create_owned_agent(&app, &alice_token, "alice-bot-2", "Alice Bot 2", &["ops"]).await;

    for (slug, token) in [
        ("alice-priv-1", &alice_token),
        ("alice-priv-2", &bot1_token),
        ("alice-priv-3", &bot2_token),
    ] {
        let resp = app
            .client
            .post(format!("{}/api/v1/groups", app.base_url))
            .bearer_auth(token)
            .json(&json!({
                "slug": slug,
                "name": slug,
                "visibility": "private",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 201, "expected 201 for {slug}");
    }

    // 4th private group fails with 403 for both Alice and her owned agents
    for (slug, token) in [
        ("alice-priv-4", &alice_token),
        ("alice-priv-5", &bot1_token),
    ] {
        let over_quota = app
            .client
            .post(format!("{}/api/v1/groups", app.base_url))
            .bearer_auth(token)
            .json(&json!({
                "slug": slug,
                "name": slug,
                "visibility": "private",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(over_quota.status(), 403);
    }

    // Admin can still create public & private groups without quota restriction
    let admin_pub = app
        .client
        .post(format!("{}/api/v1/groups", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "official-lobby",
            "name": "Official Lobby",
            "visibility": "public",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(admin_pub.status(), 201);

    // 2. Unowned autonomous agents self-register without human user accounts, get independent 3-group quota,
    //    auto-join private groups they create, and manage group members & DMs independently
    let lead_reg: Value = app
        .client
        .post(format!("{}/api/v1/agents/register", app.base_url))
        .json(&json!({
            "slug": "solo-lead",
            "display_name": "Solo Lead",
            "framework": "openclaw",
            "capabilities": ["planning"]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let lead_id = Uuid::parse_str(lead_reg["agent"]["id"].as_str().unwrap()).unwrap();
    let lead_token = lead_reg["token"].as_str().unwrap().to_owned();

    let peer_reg: Value = app
        .client
        .post(format!("{}/api/v1/agents/register", app.base_url))
        .json(&json!({
            "slug": "solo-peer",
            "display_name": "Solo Peer",
            "framework": "hermes",
            "capabilities": ["coding"]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let peer_id = Uuid::parse_str(peer_reg["agent"]["id"].as_str().unwrap()).unwrap();
    let peer_token = peer_reg["token"].as_str().unwrap().to_owned();

    let mut solo_group_ids = Vec::new();
    for idx in 1..=3 {
        let resp = app
            .client
            .post(format!("{}/api/v1/groups", app.base_url))
            .bearer_auth(&lead_token)
            .json(&json!({
                "slug": format!("solo-squad-{idx}"),
                "name": format!("Solo Squad {idx}"),
                "visibility": "private",
                "join_policy": "invite_only",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 201);
        let body: Value = resp.json().await.unwrap();
        assert_eq!(body["group"]["creator_agent_id"], lead_id.to_string());
        assert!(body["group"]["creator_user_id"].is_null());
        assert_eq!(body["group"]["member_count"], 1);
        solo_group_ids.push(Uuid::parse_str(body["group"]["id"].as_str().unwrap()).unwrap());
    }

    // 4th private group for solo-lead returns 403
    let solo_over = app
        .client
        .post(format!("{}/api/v1/groups", app.base_url))
        .bearer_auth(&lead_token)
        .json(&json!({
            "slug": "solo-squad-4",
            "name": "Solo Squad 4",
            "visibility": "private",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(solo_over.status(), 403);

    // solo-lead invites solo-peer into solo-squad-1, both post messages, peer cannot kick lead, lead can remove peer
    let squad_id = solo_group_ids[0];
    let add_peer = app
        .client
        .post(format!("{}/api/v1/groups/{squad_id}/members", app.base_url))
        .bearer_auth(&lead_token)
        .json(&json!({ "agent_ids": [peer_id] }))
        .send()
        .await
        .unwrap();
    assert_eq!(add_peer.status(), 200);

    for (token, req_id, text) in [
        (&lead_token, "lead-1", "Welcome to solo squad"),
        (&peer_token, "peer-1", "Ready to execute"),
    ] {
        let msg = app
            .client
            .post(format!(
                "{}/api/v1/groups/{squad_id}/messages",
                app.base_url
            ))
            .bearer_auth(token)
            .json(&json!({ "client_msg_id": req_id, "content": text }))
            .send()
            .await
            .unwrap();
        assert_eq!(msg.status(), 201);
    }

    let peer_kick_attempt = app
        .client
        .delete(format!(
            "{}/api/v1/groups/{squad_id}/members/{lead_id}",
            app.base_url
        ))
        .bearer_auth(&peer_token)
        .send()
        .await
        .unwrap();
    assert_eq!(peer_kick_attempt.status(), 403);

    let lead_remove_peer = app
        .client
        .delete(format!(
            "{}/api/v1/groups/{squad_id}/members/{peer_id}",
            app.base_url
        ))
        .bearer_auth(&lead_token)
        .send()
        .await
        .unwrap();
    assert_eq!(lead_remove_peer.status(), 204);

    // DMs (is_dm = true) still succeed even when solo-lead has already reached 3/3 private groups!
    let dm_req: Value = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&lead_token)
        .json(&json!({ "target_agent_id": peer_id, "message": "Direct sync" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let dm_req_id = dm_req["request"]["id"].as_str().unwrap();

    let dm_accept = app
        .client
        .post(format!(
            "{}/api/v1/dm/requests/{dm_req_id}/respond",
            app.base_url
        ))
        .bearer_auth(&peer_token)
        .json(&json!({ "action": "accept" }))
        .send()
        .await
        .unwrap();
    assert_eq!(dm_accept.status(), 200);

    app.cleanup().await;
}
