mod common;

use agentmesh_server::auth::hash_token;
use agentmesh_server::state::AppState;
use common::{TestApp, TEST_ADMIN_TOKEN};
use serde_json::{json, Value};

#[tokio::test]
async fn agent_registration_auth_warmup_revocation_and_anonymous_read() {
    let app = TestApp::spawn().await;

    // 1. 公开健康检查免鉴权
    let health = app
        .client
        .get(format!("{}/api/v1/health", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), 200);

    // 2. 无凭证与错误凭证调用 admin 接口被拒
    let no_auth = app
        .client
        .post(format!("{}/api/v1/admin/agents", app.base_url))
        .json(&json!({"slug":"bot-1","display_name":"Bot 1","framework":"openclaw"}))
        .send()
        .await
        .unwrap();
    assert_eq!(no_auth.status(), 401);

    let wrong_auth = app
        .client
        .post(format!("{}/api/v1/admin/agents", app.base_url))
        .bearer_auth("wrong_token")
        .json(&json!({"slug":"bot-1","display_name":"Bot 1","framework":"openclaw"}))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_auth.status(), 403);

    // 3. 正常注册一次性返回明文 token，数据库仅存 SHA-256 哈希
    let (agent_id, token) = app
        .register_agent("openclaw-alpha", "OpenClaw Alpha", "openclaw")
        .await;
    assert!(token.starts_with("amesh_"));

    let stored_hash: Vec<u8> = sqlx::query_scalar("SELECT token_sha256 FROM agents WHERE id = $1")
        .bind(agent_id)
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(stored_hash.as_slice(), hash_token(&token).as_slice());

    // 4. 普通 Agent Token 不能调用管理接口，重复 slug 返回 409
    let agent_try_admin = app
        .client
        .post(format!("{}/api/v1/admin/agents", app.base_url))
        .bearer_auth(&token)
        .json(&json!({"slug":"bot-2","display_name":"Bot 2","framework":"hermes"}))
        .send()
        .await
        .unwrap();
    assert_eq!(agent_try_admin.status(), 403);

    let dup_slug = app
        .client
        .post(format!("{}/api/v1/admin/agents", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({"slug":"openclaw-alpha","display_name":"Dup","framework":"openclaw"}))
        .send()
        .await
        .unwrap();
    assert_eq!(dup_slug.status(), 409);

    // 5. 内存缓存鉴权通过，且重启预热（AppState::new）同样可识别该 token
    let me_ok = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(me_ok.status(), 200);
    let me_json: Value = me_ok.json().await.unwrap();
    assert_eq!(me_json["agent"]["slug"], "openclaw-alpha");

    let warmed_state = AppState::new(app.db.clone(), TEST_ADMIN_TOKEN, 64, 1024)
        .await
        .unwrap();
    assert!(warmed_state.auth_cache.verify_token(&token).is_some());

    // 6. 轮换 Token 后旧 Token 立即失效，新 Token 立即生效
    let rotate_resp = app
        .client
        .post(format!(
            "{}/api/v1/admin/agents/{agent_id}/rotate-token",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(rotate_resp.status(), 200);
    let rotate_body: Value = rotate_resp.json().await.unwrap();
    let new_token = rotate_body["token"].as_str().unwrap().to_owned();
    assert_ne!(new_token, token);

    let old_me = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(old_me.status(), 401);

    let new_me = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&new_token)
        .send()
        .await
        .unwrap();
    assert_eq!(new_me.status(), 200);

    // 7. 吊销后零延迟返回 401
    let revoke_resp = app
        .client
        .post(format!(
            "{}/api/v1/admin/agents/{agent_id}/revoke",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(revoke_resp.status(), 200);

    let after_revoke = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&new_token)
        .send()
        .await
        .unwrap();
    assert_eq!(after_revoke.status(), 401);

    // 8. 匿名公开只读查询免鉴权且不泄露任何 token / sha256 字段
    let list_resp = app
        .client
        .get(format!("{}/api/v1/agents", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(list_resp.status(), 200);
    let raw_list = list_resp.text().await.unwrap();
    assert!(!raw_list.contains("token"));
    assert!(!raw_list.contains("sha256"));
    let parsed_list: Value = serde_json::from_str(&raw_list).unwrap();
    assert_eq!(parsed_list["agents"][0]["slug"], "openclaw-alpha");
    assert_eq!(parsed_list["agents"][0]["is_revoked"], true);

    app.cleanup().await;
}

#[tokio::test]
async fn autonomous_agent_self_registration_self_governance_and_user_claim() {
    let app = TestApp::spawn().await;

    // 1. 免人类账号、免鉴权直接注册独立 Agent
    let reg_resp = app
        .client
        .post(format!("{}/api/v1/agents/register", app.base_url))
        .json(&json!({
            "slug": "solo-scout",
            "display_name": "Solo Scout",
            "framework": "openclaw",
            "description": "Autonomous crawler",
            "capabilities": ["search", "triage"]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(reg_resp.status(), 201);
    let reg_body: Value = reg_resp.json().await.unwrap();
    let agent_id = reg_body["agent"]["id"].as_str().unwrap().to_owned();
    let token_v1 = reg_body["token"].as_str().unwrap().to_owned();
    assert!(token_v1.starts_with("amesh_"));
    assert!(reg_body["agent"]["owner_user_id"].is_null());
    assert!(reg_body["agent"]["owner_username"].is_null());

    // 重复 slug 返回 409
    let dup_resp = app
        .client
        .post(format!("{}/api/v1/agents/register", app.base_url))
        .json(&json!({
            "slug": "solo-scout",
            "display_name": "Solo Scout 2",
            "framework": "hermes"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup_resp.status(), 409);

    // 2. Agent 凭自身 amesh_ token 更新自身档案与能力标签，内存缓存同步刷新
    let patch_resp = app
        .client
        .patch(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&token_v1)
        .json(&json!({
            "display_name": "Solo Scout v2",
            "description": "Autonomous research agent",
            "capabilities": ["search", "sql", "rust"]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_resp.status(), 200);
    let patch_body: Value = patch_resp.json().await.unwrap();
    assert_eq!(patch_body["agent"]["display_name"], "Solo Scout v2");
    assert_eq!(
        patch_body["agent"]["capabilities"],
        json!(["rust", "search", "sql"])
    );
    assert_eq!(
        app.state
            .auth_cache
            .verify_token(&token_v1)
            .unwrap()
            .display_name,
        "Solo Scout v2"
    );

    // 3. Agent 自助轮换自身 Token，旧 Token 立即失效
    let rotate_resp = app
        .client
        .post(format!("{}/api/v1/agents/me/rotate-token", app.base_url))
        .bearer_auth(&token_v1)
        .send()
        .await
        .unwrap();
    assert_eq!(rotate_resp.status(), 200);
    let rotate_body: Value = rotate_resp.json().await.unwrap();
    let token_v2 = rotate_body["token"].as_str().unwrap().to_owned();
    assert_ne!(token_v2, token_v1);

    let old_me = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&token_v1)
        .send()
        .await
        .unwrap();
    assert_eq!(old_me.status(), 401);

    let new_me = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&token_v2)
        .send()
        .await
        .unwrap();
    assert_eq!(new_me.status(), 200);

    // 4. 人类用户凭有效 amesh_ token 认领独立 Agent，其它用户再次认领返回 409
    let alice_reg: Value = app
        .client
        .post(format!("{}/api/v1/auth/register", app.base_url))
        .json(&json!({
            "username": "alice",
            "display_name": "Alice",
            "password": "password123"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let alice_id = alice_reg["user"]["id"].as_str().unwrap().to_owned();
    let alice_token = alice_reg["token"].as_str().unwrap().to_owned();

    let bob_reg: Value = app
        .client
        .post(format!("{}/api/v1/auth/register", app.base_url))
        .json(&json!({
            "username": "bob",
            "display_name": "Bob",
            "password": "password123"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let bob_token = bob_reg["token"].as_str().unwrap().to_owned();

    // 旧失效 token 无法认领
    let bad_claim = app
        .client
        .post(format!("{}/api/v1/me/agents/claim", app.base_url))
        .bearer_auth(&alice_token)
        .json(&json!({ "agent_token": token_v1 }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_claim.status(), 401);

    // Alice 认领成功
    let claim_ok = app
        .client
        .post(format!("{}/api/v1/me/agents/claim", app.base_url))
        .bearer_auth(&alice_token)
        .json(&json!({ "agent_token": token_v2 }))
        .send()
        .await
        .unwrap();
    assert_eq!(claim_ok.status(), 200);
    let claim_body: Value = claim_ok.json().await.unwrap();
    assert_eq!(claim_body["agent"]["id"], agent_id);
    assert_eq!(claim_body["agent"]["owner_user_id"], alice_id);
    assert_eq!(claim_body["agent"]["owner_username"], "alice");

    // 同一拥有者重复认领幂等返回 200
    let claim_idempotent = app
        .client
        .post(format!("{}/api/v1/me/agents/claim", app.base_url))
        .bearer_auth(&alice_token)
        .json(&json!({ "agent_token": token_v2 }))
        .send()
        .await
        .unwrap();
    assert_eq!(claim_idempotent.status(), 200);

    // Bob 企图认领已被 Alice 拥有的 Agent 返回 409
    let claim_conflict = app
        .client
        .post(format!("{}/api/v1/me/agents/claim", app.base_url))
        .bearer_auth(&bob_token)
        .json(&json!({ "agent_token": token_v2 }))
        .send()
        .await
        .unwrap();
    assert_eq!(claim_conflict.status(), 409);

    let alice_agents: Value = app
        .client
        .get(format!("{}/api/v1/me/agents", app.base_url))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(alice_agents["agents"].as_array().unwrap().len(), 1);
    assert_eq!(alice_agents["agents"][0]["id"], agent_id);

    // 5. Agent 自助吊销自身凭证后立即返回 401
    let revoke_me = app
        .client
        .post(format!("{}/api/v1/agents/me/revoke", app.base_url))
        .bearer_auth(&token_v2)
        .send()
        .await
        .unwrap();
    assert_eq!(revoke_me.status(), 200);
    let revoke_body: Value = revoke_me.json().await.unwrap();
    assert_eq!(revoke_body["agent"]["is_revoked"], true);

    let after_self_revoke = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&token_v2)
        .send()
        .await
        .unwrap();
    assert_eq!(after_self_revoke.status(), 401);

    app.cleanup().await;
}
