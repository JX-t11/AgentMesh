mod common;

use agentmesh_server::state::AppState;
use common::{TestApp, TEST_ADMIN_TOKEN};
use serde_json::{json, Value};
use uuid::Uuid;

async fn register_user(app: &TestApp, username: &str) -> (Uuid, String) {
    let body: Value = app
        .client
        .post(format!("{}/api/v1/auth/register", app.base_url))
        .json(&json!({
            "username": username,
            "display_name": username,
            "password": "governance-password-1"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap();
    (id, body["token"].as_str().unwrap().to_owned())
}

async fn create_agent(app: &TestApp, slug: &str) -> (Uuid, String) {
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

async fn create_board(app: &TestApp, slug: &str) -> Uuid {
    let body: Value = app
        .client
        .post(format!("{}/api/v1/admin/boards", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({"slug": slug, "name": slug, "visibility": "public"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    Uuid::parse_str(body["board"]["id"].as_str().unwrap()).unwrap()
}

async fn create_post(app: &TestApp, token: &str, board_id: Uuid, req: &str, title: &str) -> Value {
    let response = app
        .client
        .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
        .bearer_auth(token)
        .json(&json!({
            "client_req_id": req,
            "title": title,
            "content": "governance fixture content"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        201,
        "create_post failed: {}",
        response.text().await.unwrap()
    );
    response.json().await.unwrap()
}

async fn create_comment(app: &TestApp, token: &str, post_id: Uuid, req: &str) -> Value {
    app.client
        .post(format!("{}/api/v1/posts/{post_id}/comments", app.base_url))
        .bearer_auth(token)
        .json(&json!({
            "client_req_id": req,
            "content": "governance comment fixture"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn admin_can_hide_and_restore_posts() {
    let app = TestApp::spawn().await;
    let (_, agent_token) = create_agent(&app, "post-author").await;
    let board_id = create_board(&app, "governance-posts").await;
    let post = create_post(
        &app,
        &agent_token,
        board_id,
        &format!("post-{}", Uuid::new_v4().simple()),
        "Visible post",
    )
    .await;
    let post_id = Uuid::parse_str(post["post"]["id"].as_str().unwrap()).unwrap();

    let visible = app
        .client
        .get(format!("{}/api/v1/posts/{post_id}", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(visible.status(), 200);

    let hidden = app
        .client
        .post(format!(
            "{}/api/v1/admin/posts/{post_id}/hide",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({"reason": "abusive content"}))
        .send()
        .await
        .unwrap();
    assert_eq!(hidden.status(), 200);

    let hidden_get = app
        .client
        .get(format!("{}/api/v1/posts/{post_id}", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(hidden_get.status(), 404);

    let listed: Value = app
        .client
        .get(format!("{}/api/v1/posts", app.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!listed["posts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == post["post"]["id"]));

    let restored = app
        .client
        .post(format!(
            "{}/api/v1/admin/posts/{post_id}/restore",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(restored.status(), 200);

    let restored_get = app
        .client
        .get(format!("{}/api/v1/posts/{post_id}", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(restored_get.status(), 200);

    let restored_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT restored_at FROM posts WHERE id = $1")
            .bind(post_id)
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert!(restored_at.is_some());

    app.cleanup().await;
}

#[tokio::test]
async fn admin_can_hide_comments_and_count_stays_visible() {
    let app = TestApp::spawn().await;
    let (_, agent_token) = create_agent(&app, "comment-author").await;
    let board_id = create_board(&app, "governance-comments").await;
    let post = create_post(
        &app,
        &agent_token,
        board_id,
        &format!("post-{}", Uuid::new_v4().simple()),
        "Post with comment",
    )
    .await;
    let post_id = Uuid::parse_str(post["post"]["id"].as_str().unwrap()).unwrap();
    let comment = create_comment(&app, &agent_token, post_id, "comment-1").await;
    let comment_id = Uuid::parse_str(comment["comment"]["id"].as_str().unwrap()).unwrap();

    let hidden = app
        .client
        .post(format!(
            "{}/api/v1/admin/comments/{comment_id}/hide",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({"reason": "spam"}))
        .send()
        .await
        .unwrap();
    assert_eq!(hidden.status(), 200);

    let listed: Value = app
        .client
        .get(format!("{}/api/v1/posts/{post_id}/comments", app.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!listed["comments"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == comment["comment"]["id"]));

    let post_json: Value = app
        .client
        .get(format!("{}/api/v1/posts/{post_id}", app.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(post_json["post"]["comment_count"], 0);

    let restored = app
        .client
        .post(format!(
            "{}/api/v1/admin/comments/{comment_id}/restore",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(restored.status(), 200);
    let restored_json: Value = restored.json().await.unwrap();
    assert_eq!(restored_json["post_comment_count"], 1);

    app.cleanup().await;
}

#[tokio::test]
async fn users_can_report_content_and_admins_can_resolve_reports() {
    let app = TestApp::spawn().await;
    let (_, reporter_token) = register_user(&app, "reporter").await;
    let (_, agent_token) = create_agent(&app, "reported-author").await;
    let board_id = create_board(&app, "reported-posts").await;
    let post = create_post(
        &app,
        &agent_token,
        board_id,
        &format!("post-{}", Uuid::new_v4().simple()),
        "Reported post",
    )
    .await;
    let post_id = Uuid::parse_str(post["post"]["id"].as_str().unwrap()).unwrap();

    let report: Value = app
        .client
        .post(format!("{}/api/v1/reports/posts/{post_id}", app.base_url))
        .bearer_auth(&reporter_token)
        .json(&json!({"reason": "policy violation"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(report["report"]["status"], "pending");
    let report_id = Uuid::parse_str(report["report"]["id"].as_str().unwrap()).unwrap();

    let duplicate = app
        .client
        .post(format!("{}/api/v1/reports/posts/{post_id}", app.base_url))
        .bearer_auth(&reporter_token)
        .json(&json!({"reason": "still policy violation"}))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), 409);

    let pending: Value = app
        .client
        .get(format!(
            "{}/api/v1/admin/reports?status=pending",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(pending["reports"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == report["report"]["id"]));

    let resolved = app
        .client
        .post(format!(
            "{}/api/v1/admin/reports/{report_id}/resolve",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({"action": "dismiss"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resolved.status(), 200);
    let resolved_body: Value = resolved.json().await.unwrap();
    assert_eq!(resolved_body["report"]["status"], "dismissed");

    let pending_after: Value = app
        .client
        .get(format!(
            "{}/api/v1/admin/reports?status=pending",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(pending_after["reports"].as_array().unwrap().len(), 0);

    app.cleanup().await;
}

#[tokio::test]
async fn admin_can_ban_and_unban_agent_without_destroying_its_token() {
    let app = TestApp::spawn().await;
    let (agent_id, agent_token) = create_agent(&app, "ban-target").await;

    let banned = app
        .client
        .post(format!(
            "{}/api/v1/admin/agents/{agent_id}/ban",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({"reason": "repeated abuse"}))
        .send()
        .await
        .unwrap();
    assert_eq!(banned.status(), 200);
    let banned_body: Value = banned.json().await.unwrap();
    assert_eq!(banned_body["agent"]["is_banned"], true);

    let me_while_banned = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(me_while_banned.status(), 401);

    let unbanned = app
        .client
        .post(format!(
            "{}/api/v1/admin/agents/{agent_id}/unban",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(unbanned.status(), 200);
    let unbanned_body: Value = unbanned.json().await.unwrap();
    assert_eq!(unbanned_body["agent"]["is_banned"], false);

    let me_after_unban = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(me_after_unban.status(), 200);

    app.cleanup().await;
}

#[tokio::test]
async fn admin_governance_actions_are_audited() {
    let app = TestApp::spawn().await;
    let (agent_id, _) = create_agent(&app, "audited-agent").await;
    let banned = app
        .client
        .post(format!(
            "{}/api/v1/admin/agents/{agent_id}/ban",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({"reason": "audit fixture"}))
        .send()
        .await
        .unwrap();
    assert_eq!(banned.status(), 200);

    let logs: Value = app
        .client
        .get(format!("{}/api/v1/admin/audit-logs", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(logs["logs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["action"] == "agent_ban"
            && item["subject_type"] == "agent"
            && item["subject_id"] == json!(agent_id)));

    app.cleanup().await;
}

#[tokio::test]
async fn app_state_can_build_router_after_governance_migration() {
    let app = TestApp::spawn().await;
    let _: AppState = app.state.clone();
    app.cleanup().await;
}
