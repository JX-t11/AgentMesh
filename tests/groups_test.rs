mod common;

use std::time::Duration;

use agentmesh_server::events::{encode_event, AgentSignal};
use common::{TestApp, TEST_ADMIN_TOKEN};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use uuid::Uuid;

#[tokio::test]
async fn group_admin_lifecycle_and_realtime_membership_cut_off() {
    let app = TestApp::spawn().await;
    let (agent_a, token_a) = app.register_agent("oc-1", "OpenClaw 1", "openclaw").await;
    let (agent_b, token_b) = app.register_agent("hm-1", "Hermes 1", "hermes").await;

    let mut req = format!("{}/api/v1/ws/agent", app.ws_base_url)
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token_a}")).unwrap(),
    );
    let (mut ws_a, _) = connect_async(req).await.unwrap();
    let welcome = recv_json(&mut ws_a).await;
    assert_eq!(welcome["subscribed_groups"].as_array().unwrap().len(), 0);

    let create_resp = app
        .client
        .post(format!("{}/api/v1/admin/groups", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "core-dev",
            "name": "Core Dev Group",
            "description": "Main collaboration room",
            "member_agent_ids": [agent_b],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(create_resp.status(), 201);
    let group_json: Value = create_resp.json().await.unwrap();
    let group_id = Uuid::parse_str(group_json["group"]["id"].as_str().unwrap()).unwrap();

    // 动态拉 agent_a 进群
    let add_resp = app
        .client
        .post(format!(
            "{}/api/v1/admin/groups/{group_id}/members",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({ "agent_id": agent_a }))
        .send()
        .await
        .unwrap();
    assert_eq!(add_resp.status(), 200);
    let joined_ev = recv_json(&mut ws_a).await;
    assert_eq!(joined_ev["type"], "group_joined");

    // 真实调用发消息接口：agent_b 在群里发消息并 @agent_a，agent_a 同时收到群消息与个人收件箱唤醒
    let send_resp = app
        .client
        .post(format!(
            "{}/api/v1/groups/{group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&token_b)
        .json(&json!({
            "client_msg_id": "m-1",
            "content": "Hello @oc-1 please review!",
            "mention_agent_ids": [agent_a],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_resp.status(), 201);

    let f1 = recv_json(&mut ws_a).await;
    let f2 = recv_json(&mut ws_a).await;
    let types = [f1["type"].as_str().unwrap(), f2["type"].as_str().unwrap()];
    assert!(types.contains(&"group_message") && types.contains(&"inbox_event"));

    // 移除 agent_a 出群后，agent_a 不能再发言（403），且不再收到后续群消息
    let del_resp = app
        .client
        .delete(format!(
            "{}/api/v1/admin/groups/{group_id}/members/{agent_a}",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(del_resp.status(), 204);
    assert_eq!(recv_json(&mut ws_a).await["type"], "group_left");

    let post_after_removed = app
        .client
        .post(format!(
            "{}/api/v1/groups/{group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&token_a)
        .json(&json!({ "client_msg_id": "m-denied", "content": "still here?" }))
        .send()
        .await
        .unwrap();
    assert_eq!(post_after_removed.status(), 403);

    // agent_b 再发一条群消息，验证已移出的 agent_a 不会收到
    let send_2 = app
        .client
        .post(format!(
            "{}/api/v1/groups/{group_id}/messages",
            app.base_url
        ))
        .bearer_auth(&token_b)
        .json(&json!({ "client_msg_id": "m-2", "content": "internal update" }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_2.status(), 201);

    app.state.events.send_agent(
        agent_a,
        AgentSignal::Frame(encode_event(&json!({ "type": "marker" }))),
    );
    assert_eq!(recv_json(&mut ws_a).await["type"], "marker");

    app.cleanup().await;
}

#[tokio::test]
async fn group_message_1rtt_cte_permissions_validation_idempotency_and_cursors() {
    let app = TestApp::spawn().await;
    let (agent_a, token_a) = app.register_agent("agent-a", "Agent A", "openclaw").await;
    let (agent_b, token_b) = app.register_agent("agent-b", "Agent B", "hermes").await;
    let (outsider, token_outsider) = app.register_agent("outsider", "Outsider", "hermes").await;

    let g1_resp: Value = app
        .client
        .post(format!("{}/api/v1/admin/groups", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "group-one",
            "name": "Group One",
            "member_agent_ids": [agent_a, agent_b],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let group_1 = Uuid::parse_str(g1_resp["group"]["id"].as_str().unwrap()).unwrap();

    let g2_resp: Value = app
        .client
        .post(format!("{}/api/v1/admin/groups", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({
            "slug": "group-two",
            "name": "Group Two",
            "member_agent_ids": [agent_a],
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let group_2 = Uuid::parse_str(g2_resp["group"]["id"].as_str().unwrap()).unwrap();

    // 1. 非成员发言 -> 403 Forbidden
    let outsider_post = app
        .client
        .post(format!("{}/api/v1/groups/{group_1}/messages", app.base_url))
        .bearer_auth(&token_outsider)
        .json(&json!({ "client_msg_id": "out-1", "content": "let me in" }))
        .send()
        .await
        .unwrap();
    assert_eq!(outsider_post.status(), 403);

    // 2. @ 非群成员 -> 422 且不消耗群 seq
    let bad_mention = app
        .client
        .post(format!("{}/api/v1/groups/{group_1}/messages", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({
            "client_msg_id": "bad-m1",
            "content": "ping outsider",
            "mention_agent_ids": [outsider],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_mention.status(), 422);

    // 3. 引用跨群消息 -> 422 且不消耗 group_1 的 seq
    let g2_msg: Value = app
        .client
        .post(format!("{}/api/v1/groups/{group_2}/messages", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({ "client_msg_id": "g2-m1", "content": "msg in group 2" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let g2_msg_id = Uuid::parse_str(g2_msg["message"]["id"].as_str().unwrap()).unwrap();

    let cross_reply = app
        .client
        .post(format!("{}/api/v1/groups/{group_1}/messages", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({
            "client_msg_id": "bad-r1",
            "content": "cross group reply",
            "reply_to_msg_id": g2_msg_id,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(cross_reply.status(), 422);

    // 4. 首条合法消息必须分配 seq = 1（证明前面失败请求均未消耗 seq）
    let m1_resp = app
        .client
        .post(format!("{}/api/v1/groups/{group_1}/messages", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({
            "client_msg_id": "g1-m1",
            "content": "First valid message @agent-b",
            "mention_agent_ids": [agent_b, agent_a],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(m1_resp.status(), 201);
    let m1_json: Value = m1_resp.json().await.unwrap();
    assert_eq!(m1_json["message"]["seq"], 1);
    let m1_id = Uuid::parse_str(m1_json["message"]["id"].as_str().unwrap()).unwrap();

    // 验证只有 agent_b 收到收件箱通知，agent_a 自己 @ 自己不产生冗余通知
    let inbox_b: Value = app
        .client
        .get(format!("{}/api/v1/inbox", app.base_url))
        .bearer_auth(&token_b)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(inbox_b["items"].as_array().unwrap().len(), 1);
    assert_eq!(inbox_b["items"][0]["kind"], "group_mention");

    let inbox_a: Value = app
        .client
        .get(format!("{}/api/v1/inbox", app.base_url))
        .bearer_auth(&token_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(inbox_a["items"].as_array().unwrap().len(), 0);

    // 5. 幂等重试：相同 client_msg_id + 相同内容（哪怕 mention 顺序重复不同，入口已规整）-> 200 OK 返回原消息，seq 仍为 1
    let retry_ok = app
        .client
        .post(format!("{}/api/v1/groups/{group_1}/messages", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({
            "client_msg_id": "g1-m1",
            "content": "First valid message @agent-b",
            "mention_agent_ids": [agent_a, agent_b, agent_b],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(retry_ok.status(), 200);
    let retry_json: Value = retry_ok.json().await.unwrap();
    assert_eq!(retry_json["message"]["id"], m1_id.to_string());
    assert_eq!(retry_json["message"]["seq"], 1);

    // 6. 幂等冲突：相同 client_msg_id 但修改了内容 -> 409 Conflict
    let retry_conflict = app
        .client
        .post(format!("{}/api/v1/groups/{group_1}/messages", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({
            "client_msg_id": "g1-m1",
            "content": "Mutated message text!",
            "mention_agent_ids": [agent_b, agent_a],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(retry_conflict.status(), 409);

    // 7. 连续再发 4 条消息（含同群合法引用回复），测试 after_seq 与 before_seq 游标分页
    for i in 2..=5 {
        let r = app
            .client
            .post(format!("{}/api/v1/groups/{group_1}/messages", app.base_url))
            .bearer_auth(&token_b)
            .json(&json!({
                "client_msg_id": format!("g1-m{i}"),
                "content": format!("Reply #{i}"),
                "reply_to_msg_id": m1_id,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 201);
        let rj: Value = r.json().await.unwrap();
        assert_eq!(rj["message"]["seq"], i);
    }

    let forward: Value = app
        .client
        .get(format!(
            "{}/api/v1/groups/{group_1}/messages?after_seq=2&limit=2",
            app.base_url
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let f_seqs: Vec<i64> = forward["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(f_seqs, vec![3, 4]);
    assert_eq!(forward["has_more"], true);

    let backward: Value = app
        .client
        .get(format!(
            "{}/api/v1/groups/{group_1}/messages?before_seq=4&limit=2",
            app.base_url
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let b_seqs: Vec<i64> = backward["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(b_seqs, vec![2, 3]);
    assert_eq!(backward["has_more"], true);

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
