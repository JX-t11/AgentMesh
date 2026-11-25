mod common;

use agentmesh_server::state::AppState;
use common::{TestApp, TEST_ADMIN_TOKEN};
use serde_json::{json, Value};
use uuid::Uuid;

#[tokio::test]
async fn user_passwords_are_stored_with_argon2id() {
    let app = TestApp::spawn().await;
    let register: Value = app
        .client
        .post(format!("{}/api/v1/auth/register", app.base_url))
        .json(&json!({
            "username": "argon-user",
            "display_name": "Argon User",
            "password": "password123"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let user_id = Uuid::parse_str(register["user"]["id"].as_str().unwrap()).unwrap();

    let (salt, hash): (Vec<u8>, Vec<u8>) =
        sqlx::query_as("SELECT password_salt, password_hash FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&app.db)
            .await
            .unwrap();
    let hash_text = String::from_utf8(hash.clone()).unwrap();
    assert!(hash_text.starts_with("$argon2id$"), "got {hash_text}");
    assert!(!salt.is_empty());
    assert_ne!(
        hash.as_slice(),
        agentmesh_server::auth::hash_password("password123")
            .1
            .as_slice()
    );

    app.cleanup().await;
}

#[tokio::test]
async fn expired_user_sessions_are_rejected() {
    let app = TestApp::spawn().await;
    let registered: Value = app
        .client
        .post(format!("{}/api/v1/auth/register", app.base_url))
        .json(&json!({
            "username": "session-user",
            "display_name": "Session User",
            "password": "password123"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = registered["token"].as_str().unwrap().to_owned();
    let user_id = Uuid::parse_str(registered["user"]["id"].as_str().unwrap()).unwrap();

    let expires_at: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT expires_at FROM user_sessions WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert!(expires_at > chrono::Utc::now());

    let me_before = app
        .client
        .get(format!("{}/api/v1/auth/me", app.base_url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(me_before.status(), 200);

    sqlx::query("UPDATE user_sessions SET expires_at = NOW() - INTERVAL '1 second'")
        .bind(user_id)
        .execute(&app.db)
        .await
        .unwrap();

    let cleaned = app.state.cleanup_expired_user_sessions().await.unwrap();
    assert_eq!(cleaned, 1);

    let warmed_state = AppState::new(app.db.clone(), TEST_ADMIN_TOKEN, 64, 1024)
        .await
        .unwrap();
    assert!(warmed_state.auth_cache.verify_user_token(&token).is_none());

    app.cleanup().await;
}

#[tokio::test]
async fn repeated_login_failures_rate_limit_the_username() {
    let app = TestApp::spawn().await;
    let _ = app
        .client
        .post(format!("{}/api/v1/auth/register", app.base_url))
        .json(&json!({
            "username": "rate-user",
            "display_name": "Rate User",
            "password": "password123"
        }))
        .send()
        .await
        .unwrap();

    for _ in 0..5 {
        let response = app
            .client
            .post(format!("{}/api/v1/auth/login", app.base_url))
            .json(&json!({"username": "rate-user", "password": "wrong-password"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
    }

    let correct = app
        .client
        .post(format!("{}/api/v1/auth/login", app.base_url))
        .json(&json!({"username": "rate-user", "password": "password123"}))
        .send()
        .await
        .unwrap();
    assert_eq!(correct.status(), 429);

    let other_user = app
        .client
        .post(format!("{}/api/v1/auth/register", app.base_url))
        .json(&json!({
            "username": "other-user",
            "display_name": "Other User",
            "password": "password123"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(other_user.status(), 201);

    app.cleanup().await;
}

#[tokio::test]
async fn rotating_a_revoked_agent_preserves_revocation() {
    let app = TestApp::spawn().await;
    let registered: Value = app
        .client
        .post(format!("{}/api/v1/agents/register", app.base_url))
        .json(&json!({"slug": "revoked-rotate", "display_name": "Revoked Rotate", "framework": "openclaw"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let agent_id = Uuid::parse_str(registered["agent"]["id"].as_str().unwrap()).unwrap();
    let token = registered["token"].as_str().unwrap().to_owned();

    let revoked = app
        .client
        .post(format!(
            "{}/api/v1/admin/agents/{agent_id}/revoke",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 200);

    let rotated = app
        .client
        .post(format!(
            "{}/api/v1/admin/agents/{agent_id}/rotate-token",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(rotated.status(), 409);

    let old_token_after_rotate = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(old_token_after_rotate.status(), 401);

    app.cleanup().await;
}
