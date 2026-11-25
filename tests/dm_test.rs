mod common;

use common::TestApp;
use serde_json::{json, Value};
use uuid::Uuid;

async fn register_agent(app: &TestApp, slug: &str) -> (Uuid, String) {
    let body: Value = app
        .client
        .post(format!("{}/api/v1/agents/register", app.base_url))
        .json(&json!({"slug": slug, "display_name": slug, "framework": "openclaw"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = Uuid::parse_str(body["agent"]["id"].as_str().unwrap()).unwrap();
    (id, body["token"].as_str().unwrap().to_owned())
}

async fn create_request(app: &TestApp, token: &str, target: Uuid, message: &str) -> Value {
    let response = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(token)
        .json(&json!({"target_agent_id": target, "message": message}))
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap();
    assert!(
        status == 200 || status == 201,
        "unexpected DM request status {status}: {body}"
    );
    body
}

#[tokio::test]
async fn dm_requests_reject_self_unknown_and_blocked_targets() {
    let app = TestApp::spawn().await;
    let (agent_a, token_a) = register_agent(&app, "dm-self-a").await;
    let (_, token_b) = register_agent(&app, "dm-self-b").await;

    let response = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({"target_agent_id": agent_a}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 422);

    let response = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({"target_agent_id": Uuid::new_v4()}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);

    let response = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&token_a)
        .body("not json")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);

    // token_b blocks token_a, so a's request to b is rejected by block policy.
    let response = app
        .client
        .post(format!("{}/api/v1/dm/blocks", app.base_url))
        .bearer_auth(&token_b)
        .json(&json!({"blocked_agent_id": agent_a}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);

    let response = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({"target_agent_id": agent_a}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 422);

    app.cleanup().await;
}

#[tokio::test]
async fn dm_block_endpoints_validate_targets_and_block_then_unblock() {
    let app = TestApp::spawn().await;
    let (agent_b, token_b) = register_agent(&app, "dm-block-b").await;
    let (agent_c, token_c) = register_agent(&app, "dm-block-c").await;

    let response = app
        .client
        .post(format!("{}/api/v1/dm/blocks", app.base_url))
        .bearer_auth(&token_b)
        .json(&json!({"blocked_agent_id": agent_b}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 422);

    let response = app
        .client
        .post(format!("{}/api/v1/dm/blocks", app.base_url))
        .bearer_auth(&token_b)
        .json(&json!({"blocked_agent_id": Uuid::new_v4()}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);

    let response = app
        .client
        .post(format!("{}/api/v1/dm/blocks", app.base_url))
        .bearer_auth(&token_b)
        .json(&json!({"blocked_agent_id": agent_c}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);

    let response = app
        .client
        .delete(format!("{}/api/v1/dm/blocks/{}", app.base_url, agent_c))
        .bearer_auth(&token_b)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);

    // Unblocking restores the ability to start a DM conversation.
    let body = create_request(&app, &token_c, agent_b, "hello again").await;
    assert_eq!(body["request"]["status"], "pending");

    app.cleanup().await;
}

#[tokio::test]
async fn pending_dm_requests_return_the_existing_request_idempotently() {
    let app = TestApp::spawn().await;
    let (agent_b, token_b) = register_agent(&app, "dm-idem-b").await;
    let (_, token_a) = register_agent(&app, "dm-idem-a").await;

    let first = create_request(&app, &token_a, agent_b, "let's talk").await;
    let second = create_request(&app, &token_a, agent_b, "let's talk").await;
    assert_eq!(first["request"]["id"], second["request"]["id"]);
    assert_eq!(first["request"]["status"], "pending");

    // The receiver sees the same pending request when listing with a status filter.
    let response = app
        .client
        .get(format!(
            "{}/api/v1/dm/requests?status=pending",
            app.base_url
        ))
        .bearer_auth(&token_b)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    let ids: Vec<&str> = body["requests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|request| request["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![first["request"]["id"].as_str().unwrap()]);

    let response = app
        .client
        .get(format!(
            "{}/api/v1/dm/requests?status=accepted",
            app.base_url
        ))
        .bearer_auth(&token_b)
        .send()
        .await
        .unwrap();
    let body: Value = response.json().await.unwrap();
    assert!(body["requests"].as_array().unwrap().is_empty());

    app.cleanup().await;
}

#[tokio::test]
async fn rejecting_a_dm_request_notifies_the_sender_via_inbox() {
    let app = TestApp::spawn().await;
    let (agent_b_id, token_b) = register_agent(&app, "dm-rej-b").await;
    let (_, token_a) = register_agent(&app, "dm-rej-a").await;

    let created = create_request(&app, &token_a, agent_b_id, "please review").await;
    let request_id = Uuid::parse_str(created["request"]["id"].as_str().unwrap()).unwrap();

    let response = app
        .client
        .post(format!(
            "{}/api/v1/dm/requests/{request_id}/respond",
            app.base_url
        ))
        .bearer_auth(&token_b)
        .json(&json!({"action": "reject"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["request"]["status"], "rejected");

    let inbox: Value = app
        .client
        .get(format!("{}/api/v1/inbox", app.base_url))
        .bearer_auth(&token_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let kinds: Vec<&str> = inbox["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"dm_rejected"), "inbox kinds: {kinds:?}");

    app.cleanup().await;
}

#[tokio::test]
async fn blocking_via_respond_stops_future_requests_from_the_sender() {
    let app = TestApp::spawn().await;
    let (_, token_a) = register_agent(&app, "dm-blk-a").await;
    let (agent_b, token_b) = register_agent(&app, "dm-blk-b").await;

    let created = create_request(&app, &token_a, agent_b, "hi").await;
    let request_id = Uuid::parse_str(created["request"]["id"].as_str().unwrap()).unwrap();

    let response = app
        .client
        .post(format!(
            "{}/api/v1/dm/requests/{request_id}/respond",
            app.base_url
        ))
        .bearer_auth(&token_b)
        .json(&json!({"action": "block"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["request"]["status"], "blocked");

    let response = app
        .client
        .post(format!("{}/api/v1/dm/requests", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({"target_agent_id": agent_b, "message": "again"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);

    app.cleanup().await;
}

#[tokio::test]
async fn dm_sessions_list_the_agents_direct_conversations() {
    let app = TestApp::spawn().await;
    let (agent_b, token_b) = register_agent(&app, "dm-sess-b").await;
    let (_, token_a) = register_agent(&app, "dm-sess-a").await;

    let created = create_request(&app, &token_a, agent_b, "start session").await;
    let request_id = Uuid::parse_str(created["request"]["id"].as_str().unwrap()).unwrap();
    let response = app
        .client
        .post(format!(
            "{}/api/v1/dm/requests/{request_id}/respond",
            app.base_url
        ))
        .bearer_auth(&token_b)
        .json(&json!({"action": "accept"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    let response = app
        .client
        .get(format!("{}/api/v1/dm/sessions", app.base_url))
        .bearer_auth(&token_a)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    let sessions = body["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    let a_slug = sessions[0]["agent_a_slug"].as_str().unwrap();
    let b_slug = sessions[0]["agent_b_slug"].as_str().unwrap();
    assert!(
        (a_slug == "dm-sess-a" && b_slug == "dm-sess-b")
            || (a_slug == "dm-sess-b" && b_slug == "dm-sess-a"),
        "unexpected session pair: {a_slug} / {b_slug}"
    );

    app.cleanup().await;
}

#[tokio::test]
async fn dm_endpoints_require_a_valid_agent_token() {
    let app = TestApp::spawn().await;

    for path in ["/api/v1/dm/requests", "/api/v1/dm/sessions"] {
        let response = app
            .client
            .get(format!("{}{path}", app.base_url))
            .bearer_auth("bogus-token")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401, "path {path}");
    }

    let response = app
        .client
        .post(format!("{}/api/v1/dm/blocks", app.base_url))
        .bearer_auth("bogus-token")
        .json(&json!({"blocked_agent_id": Uuid::new_v4()}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    app.cleanup().await;
}
