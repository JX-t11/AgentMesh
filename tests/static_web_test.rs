mod common;

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use common::{TestApp, TEST_ADMIN_TOKEN};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

#[tokio::test]
async fn serves_observer_spa_and_isolates_api_404_when_dist_exists() {
    let temp_dir = std::env::temp_dir().join(format!("agentmesh_web_dist_{}", Uuid::new_v4()));
    let assets_dir = temp_dir.join("assets");
    fs::create_dir_all(&assets_dir).expect("create temp dist dirs");
    fs::write(
        temp_dir.join("index.html"),
        "<!doctype html><html><body>AgentMesh Observer Test Shell</body></html>",
    )
    .expect("write index.html");
    fs::write(assets_dir.join("app.js"), "console.log('observer-ready');").expect("write app.js");

    let app = TestApp::spawn_with_web_dist(temp_dir.clone()).await;

    let root_resp = app
        .client
        .get(format!("{}/", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(root_resp.status(), 200);
    let root_html = root_resp.text().await.unwrap();
    assert!(root_html.contains("AgentMesh Observer Test Shell"));

    let asset_resp = app
        .client
        .get(format!("{}/assets/app.js", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(asset_resp.status(), 200);
    assert_eq!(
        asset_resp.text().await.unwrap(),
        "console.log('observer-ready');"
    );

    for path in [
        "/forum",
        "/forum/boards",
        "/categories",
        "/c/example-category",
        "/t/example-topic",
        "/chat",
        "/chat/example-group",
        "/docs",
        "/docs/openclaw",
        "/docs/hermes",
    ] {
        let spa_resp = app
            .client
            .get(format!("{}{path}", app.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(spa_resp.status(), 200, "SPA fallback for {path}");
        assert_eq!(
            spa_resp.text().await.unwrap(),
            root_html,
            "SPA entry for {path}"
        );
    }

    let health_resp = app
        .client
        .get(format!("{}/api/v1/health", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(health_resp.status(), 200);
    let health_json: Value = health_resp.json().await.unwrap();
    assert_eq!(health_json["status"], "ok");

    for bad_api_path in ["/api/unknown", "/api/v1/unknown-route"] {
        let not_found_resp = app
            .client
            .get(format!("{}{bad_api_path}", app.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(not_found_resp.status(), 404);
        let err_json: Value = not_found_resp.json().await.unwrap();
        assert_eq!(err_json["error"]["code"], "not_found");
    }

    app.cleanup().await;
    let _ = fs::remove_dir_all(&temp_dir);
}

#[tokio::test]
async fn boots_cleanly_when_web_dist_dir_is_missing() {
    let missing_dir =
        std::env::temp_dir().join(format!("agentmesh_missing_dist_{}", Uuid::new_v4()));
    let app = TestApp::spawn_with_web_dist(missing_dir).await;

    let health_resp = app
        .client
        .get(format!("{}/api/v1/health", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(health_resp.status(), 200);

    let root_resp = app
        .client
        .get(format!("{}/", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(root_resp.status(), 404);

    let api_404 = app
        .client
        .get(format!("{}/api/v1/does-not-exist", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(api_404.status(), 404);
    let err_json: Value = api_404.json().await.unwrap();
    assert_eq!(err_json["error"]["code"], "not_found");

    app.cleanup().await;
}

#[tokio::test]
async fn real_built_web_dist_and_live_observer_ws_full_flow() {
    let real_dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("web/dist");
    assert!(
        real_dist.join("index.html").is_file(),
        "web/dist/index.html must exist from npm run build"
    );

    let app = TestApp::spawn_with_web_dist(real_dist).await;

    // 1. 验证根路径 / 返回真实前端构建的 index.html，且引用的 JS / CSS 静态资源可同源 200 加载
    let index_resp = app
        .client
        .get(format!("{}/", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(index_resp.status(), 200);
    let index_html = index_resp.text().await.unwrap();
    assert!(index_html.contains("AgentMesh · Agent 协作社区"));
    assert!(index_html.contains("meta name=\"color-scheme\" content=\"light dark\""));

    for path in [
        "/forum",
        "/categories",
        "/c/example-category",
        "/t/example-topic",
        "/chat",
        "/chat/example-group-id",
        "/docs",
        "/docs/create-agent",
        "/docs/openclaw",
        "/docs/hermes",
        "/docs/collaboration",
        "/docs/faq",
    ] {
        let response = app
            .client
            .get(format!("{}{path}", app.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().await.unwrap(), index_html);
    }

    let js_path = extract_attr_path(&index_html, "src=\"", "/assets/")
        .expect("built index.html should reference /assets/*.js");
    let js_resp = app
        .client
        .get(format!("{}{js_path}", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(js_resp.status(), 200);
    assert!(!js_resp.bytes().await.unwrap().is_empty());

    let css_path = extract_attr_path(&index_html, "href=\"", "/assets/")
        .expect("built index.html should reference /assets/*.css");
    let css_resp = app
        .client
        .get(format!("{}{css_path}", app.base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(css_resp.status(), 200);
    assert!(!css_resp.bytes().await.unwrap().is_empty());

    for framework in ["openclaw", "hermes"] {
        let package = app
            .client
            .get(format!(
                "{}/downloads/agentmesh-{framework}.tar.gz",
                app.base_url
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(package.status(), 200);
        let bytes = package.bytes().await.unwrap();
        assert!(
            bytes.starts_with(&[0x1f, 0x8b]),
            "{framework} download is a gzip archive"
        );

        let guide = app
            .client
            .get(format!("{}/connect/{framework}.md", app.base_url))
            .send()
            .await
            .unwrap();
        assert_eq!(guide.status(), 200);
        let markdown = guide.text().await.unwrap();
        assert!(markdown.starts_with("# AgentMesh "));
        assert!(markdown.contains("agentmesh_whoami"));
        assert!(markdown.contains("/api/v1/agents/register"));
        assert!(!markdown.contains("docker build"));
    }

    // 2. 注册 OpenClaw 与 Hermes Agent，创建群组与论坛板块
    let (claw_id, claw_token) = app
        .register_agent("claw-obs-1", "Claw Observer Test", "openclaw")
        .await;
    let (hermes_id, hermes_token) = app
        .register_agent("hermes-obs-1", "Hermes Observer Test", "hermes")
        .await;

    let grp_resp: Value = app
        .client
        .post(format!("{}/api/v1/admin/groups", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "m2-e2e-group",
            "name": "M2 全栈验证群",
            "member_agent_ids": [claw_id, hermes_id],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let group_id = Uuid::parse_str(grp_resp["group"]["id"].as_str().unwrap()).unwrap();

    let brd_resp: Value = app
        .client
        .post(format!("{}/api/v1/admin/boards", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "m2-e2e-board",
            "name": "M2 全栈验证板块",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let board_id = Uuid::parse_str(brd_resp["board"]["id"].as_str().unwrap()).unwrap();

    // 3. 连接免鉴权 /api/v1/ws/observe 并订阅该群组 + 论坛全局流
    let (mut ws, _) = connect_async(format!("{}/api/v1/ws/observe", app.ws_base_url))
        .await
        .expect("connect observer ws");

    let welcome = next_ws_json(&mut ws).await;
    assert_eq!(welcome["type"], "connected");
    assert_eq!(welcome["role"], "observer");

    ws.send(Message::Text(
        json!({
            "action": "subscribe",
            "groups": [group_id],
            "forum": true,
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
    let sub_ack = next_ws_json(&mut ws).await;
    assert_eq!(sub_ack["type"], "subscribed");
    assert_eq!(sub_ack["forum"], true);

    // 4. 真实 Agent 群发 + 引用回复 + 结构化 @，验证实时流与 after_seq 补拉一致
    let m1: Value = app
        .client
        .post(format!(
            "{}/api/v1/groups/{group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&claw_token)
        .json(&json!({
            "client_msg_id": "m2-e2e-1",
            "content": "OpenClaw 发起接口对齐请求",
            "mention_agent_ids": [hermes_id],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let m1_id = m1["message"]["id"].as_str().unwrap();

    let ev_m1 = next_ws_json(&mut ws).await;
    assert_eq!(ev_m1["type"], "group_message");
    assert_eq!(ev_m1["message"]["seq"], 1);

    let _m2: Value = app
        .client
        .post(format!(
            "{}/api/v1/groups/{group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&hermes_token)
        .json(&json!({
            "client_msg_id": "m2-e2e-2",
            "content": "Hermes 已确认并回复引用",
            "reply_to_msg_id": m1_id,
            "mention_agent_ids": [claw_id],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let ev_m2 = next_ws_json(&mut ws).await;
    assert_eq!(ev_m2["type"], "group_message");
    assert_eq!(ev_m2["message"]["seq"], 2);
    assert_eq!(ev_m2["message"]["reply_to_msg_id"], m1_id);

    let catchup: Value = app
        .client
        .get(format!(
            "{}/api/v1/groups/{group_id}/messages?after_seq=1&limit=50",
            app.base_url
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(catchup["messages"].as_array().unwrap().len(), 1);
    assert_eq!(catchup["messages"][0]["seq"], 2);

    // 5. 真实 Agent 论坛发帖与盖楼评论，验证 /api/v1/ws/observe 实时收到 post_created 与 comment_created
    let post_resp: Value = app
        .client
        .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
        .bearer_auth(&claw_token)
        .json(&json!({
            "client_req_id": "m2-post-1",
            "title": "M2 观测台实时联动验收帖",
            "content": "验证论坛实时推送与盖楼引用",
            "mention_agent_ids": [hermes_id],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let post_id = post_resp["post"]["id"].as_str().unwrap();

    let ev_post = next_ws_json(&mut ws).await;
    assert_eq!(ev_post["type"], "post_created");
    assert_eq!(ev_post["post"]["id"], post_id);

    let c1_resp: Value = app
        .client
        .post(format!("{}/api/v1/posts/{post_id}/comments", app.base_url))
        .bearer_auth(&hermes_token)
        .json(&json!({
            "client_req_id": "m2-cmt-1",
            "content": "1 楼评论：流式状态正常",
            "mention_agent_ids": [claw_id],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let c1_id = c1_resp["comment"]["id"].as_str().unwrap();

    let ev_c1 = next_ws_json(&mut ws).await;
    assert_eq!(ev_c1["type"], "comment_created");
    assert_eq!(ev_c1["post_comment_count"], 1);

    let _c2_resp: Value = app
        .client
        .post(format!("{}/api/v1/posts/{post_id}/comments", app.base_url))
        .bearer_auth(&claw_token)
        .json(&json!({
            "client_req_id": "m2-cmt-2",
            "content": "2 楼盖楼回复 1 楼",
            "parent_comment_id": c1_id,
            "mention_agent_ids": [hermes_id],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let ev_c2 = next_ws_json(&mut ws).await;
    assert_eq!(ev_c2["type"], "comment_created");
    assert_eq!(ev_c2["post_comment_count"], 2);
    assert_eq!(ev_c2["comment"]["parent_comment_id"], c1_id);

    let _ = ws.close(None).await;
    app.cleanup().await;
}

fn extract_attr_path<'a>(html: &'a str, attr_prefix: &str, path_prefix: &str) -> Option<&'a str> {
    let pattern = format!("{attr_prefix}{path_prefix}");
    let start = html.find(&pattern)? + attr_prefix.len();
    let rest = &html[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

async fn next_ws_json<S>(ws: &mut S) -> Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let msg = timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("ws frame timeout")
        .expect("ws stream ended")
        .expect("ws frame error");
    match msg {
        Message::Text(txt) => serde_json::from_str(txt.as_str()).expect("valid ws json"),
        other => panic!("unexpected ws message: {other:?}"),
    }
}
