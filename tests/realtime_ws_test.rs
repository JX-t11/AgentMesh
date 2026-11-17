mod common;

use std::time::Duration;

use agentmesh_server::events::{encode_event, AgentSignal};
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
async fn inbox_cursor_and_agent_ws_stream_dynamic_groups_and_revocation() {
    let app = TestApp::spawn().await;
    let (agent_a, token_a) = app.register_agent("agent-a", "Agent A", "openclaw").await;
    let (agent_b, _token_b) = app.register_agent("agent-b", "Agent B", "hermes").await;

    // 预置 3 条收件箱事件，验证增量拉取与 ack 水位线
    for seq in 1..=3_i64 {
        sqlx::query(
            "INSERT INTO inbox_events (recipient_agent_id, inbox_seq, kind, source_id, actor_agent_id, summary)
             VALUES ($1, $2, 'post_mention', $3, $4, $5)",
        )
        .bind(agent_a)
        .bind(seq)
        .bind(Uuid::new_v4())
        .bind(agent_b)
        .bind(format!("mention #{seq}"))
        .execute(&app.db)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE agents SET last_inbox_seq = 3 WHERE id = $1")
        .bind(agent_a)
        .execute(&app.db)
        .await
        .unwrap();

    let page1: Value = app
        .client
        .get(format!(
            "{}/api/v1/inbox?after_inbox_seq=0&limit=2",
            app.base_url
        ))
        .bearer_auth(&token_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page1["items"].as_array().unwrap().len(), 2);
    assert_eq!(page1["next_after_inbox_seq"], 2);
    assert_eq!(page1["has_more"], true);
    assert_eq!(page1["items"][0]["is_acked"], false);

    // 确认前 2 条后测试 unread_only
    let ack_resp: Value = app
        .client
        .post(format!("{}/api/v1/inbox/ack", app.base_url))
        .bearer_auth(&token_a)
        .json(&json!({ "up_to_inbox_seq": 2 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ack_resp["acked_inbox_seq"], 2);

    let unread: Value = app
        .client
        .get(format!("{}/api/v1/inbox?unread_only=true", app.base_url))
        .bearer_auth(&token_a)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(unread["items"].as_array().unwrap().len(), 1);
    assert_eq!(unread["items"][0]["inbox_seq"], 3);

    // 无效 Token 连接 WS 握手直接失败
    let mut bad_req = format!("{}/api/v1/ws/agent", app.ws_base_url)
        .into_client_request()
        .unwrap();
    bad_req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_static("Bearer invalid_token"),
    );
    assert!(connect_async(bad_req).await.is_err());

    // 有效 Token 连接 Agent WS
    let mut req = format!("{}/api/v1/ws/agent", app.ws_base_url)
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token_a}")).unwrap(),
    );
    let (mut ws, _) = connect_async(req).await.expect("connect agent ws");

    let welcome = recv_json(&mut ws).await;
    assert_eq!(welcome["type"], "connected");
    assert_eq!(welcome["role"], "agent");

    // 动态加入群组 -> 接收群消息 -> 动态移除群组 -> 不再接收该群消息
    let group_id = Uuid::new_v4();
    app.state.events.send_agent(
        agent_a,
        AgentSignal::JoinGroup {
            group_id,
            frame: encode_event(&json!({ "type": "group_joined", "group_id": group_id })),
        },
    );
    let joined = recv_json(&mut ws).await;
    assert_eq!(joined["type"], "group_joined");

    app.state.events.publish_group(
        group_id,
        encode_event(&json!({ "type": "group_message", "group_id": group_id, "seq": 1 })),
    );
    let gmsg = recv_json(&mut ws).await;
    assert_eq!(gmsg["type"], "group_message");
    assert_eq!(gmsg["seq"], 1);

    app.state.events.send_agent(
        agent_a,
        AgentSignal::LeaveGroup {
            group_id,
            frame: encode_event(&json!({ "type": "group_left", "group_id": group_id })),
        },
    );
    let left = recv_json(&mut ws).await;
    assert_eq!(left["type"], "group_left");

    // 移除后再往该群广播，Agent A 不应再收到，紧接着发一条个人通知应当只收到个人通知
    app.state.events.publish_group(
        group_id,
        encode_event(&json!({ "type": "group_message", "group_id": group_id, "seq": 2 })),
    );
    app.state.events.send_agent(
        agent_a,
        AgentSignal::Frame(encode_event(
            &json!({ "type": "inbox_event", "inbox_seq": 4 }),
        )),
    );
    let next_ev = recv_json(&mut ws).await;
    assert_eq!(next_ev["type"], "inbox_event");
    assert_eq!(next_ev["inbox_seq"], 4);

    // 吊销 Agent 凭证，WS 连接立即收到关闭
    let rev = app
        .client
        .post(format!(
            "{}/api/v1/admin/agents/{agent_a}/revoke",
            app.base_url
        ))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(rev.status(), 200);

    let closed = timeout(Duration::from_secs(2), async {
        while let Some(Ok(msg)) = ws.next().await {
            if matches!(msg, WsMsg::Close(_)) {
                return true;
            }
        }
        true
    })
    .await
    .expect("ws closed promptly on revoke");
    assert!(closed);

    app.cleanup().await;
}

#[tokio::test]
async fn observer_stream_and_slow_consumer_resync_required() {
    // 将有界广播容量设为极小的 4，测试洪峰溢出下的慢消费者重同步提示
    let app = TestApp::spawn_with_capacity(4).await;
    let group_id = Uuid::new_v4();

    let (mut obs_ws, _) = connect_async(format!("{}/api/v1/ws/observe", app.ws_base_url))
        .await
        .expect("connect observer ws");

    let welcome = recv_json(&mut obs_ws).await;
    assert_eq!(welcome["role"], "observer");

    // 尝试非法写指令被拒
    obs_ws
        .send(WsMsg::Text(
            json!({ "action": "post_message", "content": "hack" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let err_frame = recv_json(&mut obs_ws).await;
    assert_eq!(err_frame["type"], "error");
    assert_eq!(err_frame["code"], "read_only_stream");

    // 订阅群组与论坛流
    obs_ws
        .send(WsMsg::Text(
            json!({ "action": "subscribe", "groups": [group_id], "forum": true })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let sub_ack = recv_json(&mut obs_ws).await;
    assert_eq!(sub_ack["type"], "subscribed");
    assert_eq!(sub_ack["forum"], true);

    // 论坛事件实时送达
    app.state.events.publish_forum(encode_event(
        &json!({ "type": "post_created", "title": "hello" }),
    ));
    let forum_ev = recv_json(&mut obs_ws).await;
    assert_eq!(forum_ev["type"], "post_created");

    // 故意在客户端不读取的情况下连发 20 条群消息（超过 broadcast 容量 4 + 服务端 task 缓冲）
    for seq in 1..=20 {
        app.state.events.publish_group(
            group_id,
            encode_event(&json!({ "type": "group_message", "seq": seq })),
        );
    }

    // 持续读取直到观察到 resync_required 控制帧
    let mut saw_resync = false;
    for _ in 0..20 {
        if let Ok(frame) = timeout(Duration::from_millis(300), recv_json(&mut obs_ws)).await {
            if frame["type"] == "resync_required" {
                assert_eq!(frame["scope"], "group");
                assert!(frame["dropped"].as_u64().unwrap() > 0);
                saw_resync = true;
                break;
            }
        } else {
            break;
        }
    }
    assert!(
        saw_resync,
        "expected slow consumer to receive resync_required frame"
    );

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
