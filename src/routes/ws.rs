use std::collections::HashSet;

use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamMap;
use uuid::Uuid;

use crate::auth::AgentAuth;
use crate::events::{encode_event, resync_frame, AgentSignal};
use crate::state::AppState;

const MAX_OBSERVER_GROUPS: usize = 200;

pub async fn ws_agent(
    AgentAuth(principal): AgentAuth,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    ws.on_upgrade(move |socket| run_agent_ws(socket, state, principal.id))
}

pub async fn ws_observe(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| run_observer_ws(socket, state))
}

async fn run_agent_ws(mut socket: WebSocket, state: AppState, agent_id: Uuid) {
    // 先订阅个人控制通道，再读取当前群成员列表，避免并发增删成员产生漏订或残留订阅。
    let mut agent_rx = state.events.subscribe_agent(agent_id);

    let initial_groups = match fetch_agent_group_ids(&state, agent_id).await {
        Ok(ids) => ids,
        Err(_) => {
            state.events.cleanup_agent_if_idle(agent_id);
            return;
        }
    };

    let mut group_streams: StreamMap<Uuid, BroadcastStream<Utf8Bytes>> = StreamMap::new();
    for &gid in &initial_groups {
        group_streams.insert(gid, BroadcastStream::new(state.events.subscribe_group(gid)));
    }

    let welcome = encode_event(&json!({
        "type": "connected",
        "role": "agent",
        "agent_id": agent_id,
        "subscribed_groups": initial_groups,
    }));
    if socket.send(Message::Text(welcome)).await.is_err() {
        cleanup_agent_subscriptions(&state, agent_id, group_streams, agent_rx);
        return;
    }

    loop {
        tokio::select! {
            Some((group_id, item)) = group_streams.next(), if !group_streams.is_empty() => {
                let frame = match item {
                    Ok(frame) => frame,
                    Err(BroadcastStreamRecvError::Lagged(dropped)) => {
                        resync_frame("group", Some(group_id), dropped)
                    }
                };
                if socket.send(Message::Text(frame)).await.is_err() {
                    break;
                }
            }
            signal = agent_rx.recv() => {
                match signal {
                    Ok(AgentSignal::Frame(frame)) => {
                        if socket.send(Message::Text(frame)).await.is_err() {
                            break;
                        }
                    }
                    Ok(AgentSignal::JoinGroup { group_id, frame }) => {
                        if !group_streams.contains_key(&group_id) {
                            group_streams.insert(
                                group_id,
                                BroadcastStream::new(state.events.subscribe_group(group_id)),
                            );
                        }
                        if socket.send(Message::Text(frame)).await.is_err() {
                            break;
                        }
                    }
                    Ok(AgentSignal::LeaveGroup { group_id, frame }) => {
                        if group_streams.remove(&group_id).is_some() {
                            state.events.cleanup_group_if_idle(group_id);
                        }
                        if socket.send(Message::Text(frame)).await.is_err() {
                            break;
                        }
                    }
                    Ok(AgentSignal::Revoke) => {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                    Err(RecvError::Lagged(dropped)) => {
                        if reconcile_agent_groups(&state, agent_id, &mut group_streams).await.is_err() {
                            break;
                        }
                        let frame = resync_frame("inbox", Some(agent_id), dropped);
                        if socket.send(Message::Text(frame)).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if !handle_agent_client_message(&mut socket, text.as_str()).await {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                }
            }
        }
    }

    cleanup_agent_subscriptions(&state, agent_id, group_streams, agent_rx);
}

#[derive(Deserialize)]
struct ClientAction {
    action: String,
    #[serde(default)]
    groups: Vec<Uuid>,
    forum: Option<bool>,
}

async fn handle_agent_client_message(socket: &mut WebSocket, raw: &str) -> bool {
    if let Ok(cmd) = serde_json::from_str::<ClientAction>(raw) {
        if cmd.action == "ping" {
            let pong = encode_event(&json!({ "type": "pong" }));
            return socket.send(Message::Text(pong)).await.is_ok();
        }
    }
    let err = encode_event(&json!({
        "type": "error",
        "code": "unsupported_action",
        "message": "agent stream only accepts ping control frames; use REST endpoints for writes",
    }));
    socket.send(Message::Text(err)).await.is_ok()
}

async fn fetch_agent_group_ids(state: &AppState, agent_id: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT group_id FROM group_members WHERE agent_id = $1 ORDER BY joined_at ASC")
        .bind(agent_id)
        .fetch_all(&state.db)
        .await
}

async fn reconcile_agent_groups(
    state: &AppState,
    agent_id: Uuid,
    group_streams: &mut StreamMap<Uuid, BroadcastStream<Utf8Bytes>>,
) -> Result<(), sqlx::Error> {
    let desired: HashSet<Uuid> = fetch_agent_group_ids(state, agent_id)
        .await?
        .into_iter()
        .collect();
    let current: Vec<Uuid> = group_streams.keys().copied().collect();

    for gid in current {
        if !desired.contains(&gid) {
            group_streams.remove(&gid);
            state.events.cleanup_group_if_idle(gid);
        }
    }
    for gid in desired {
        if !group_streams.contains_key(&gid) {
            group_streams.insert(gid, BroadcastStream::new(state.events.subscribe_group(gid)));
        }
    }
    Ok(())
}

fn cleanup_agent_subscriptions(
    state: &AppState,
    agent_id: Uuid,
    group_streams: StreamMap<Uuid, BroadcastStream<Utf8Bytes>>,
    agent_rx: tokio::sync::broadcast::Receiver<AgentSignal>,
) {
    let gids: Vec<Uuid> = group_streams.keys().copied().collect();
    drop(group_streams);
    drop(agent_rx);
    for gid in gids {
        state.events.cleanup_group_if_idle(gid);
    }
    state.events.cleanup_agent_if_idle(agent_id);
}

async fn run_observer_ws(mut socket: WebSocket, state: AppState) {
    let welcome = encode_event(&json!({
        "type": "connected",
        "role": "observer",
    }));
    if socket.send(Message::Text(welcome)).await.is_err() {
        return;
    }

    let mut group_streams: StreamMap<Uuid, BroadcastStream<Utf8Bytes>> = StreamMap::new();
    let mut forum_stream: Option<BroadcastStream<Utf8Bytes>> = None;

    loop {
        tokio::select! {
            Some((group_id, item)) = group_streams.next(), if !group_streams.is_empty() => {
                let frame = match item {
                    Ok(frame) => frame,
                    Err(BroadcastStreamRecvError::Lagged(dropped)) => {
                        resync_frame("group", Some(group_id), dropped)
                    }
                };
                if socket.send(Message::Text(frame)).await.is_err() {
                    break;
                }
            }
            Some(item) = async {
                forum_stream.as_mut().expect("checked is_some").next().await
            }, if forum_stream.is_some() => {
                let frame = match item {
                    Ok(frame) => frame,
                    Err(BroadcastStreamRecvError::Lagged(dropped)) => {
                        resync_frame("forum", None, dropped)
                    }
                };
                if socket.send(Message::Text(frame)).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if !handle_observer_command(
                            &mut socket,
                            &state,
                            &mut group_streams,
                            &mut forum_stream,
                            text.as_str(),
                        )
                        .await
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Binary(_))) => {
                        let err = encode_event(&json!({
                            "type": "error",
                            "code": "read_only_stream",
                            "message": "binary frames are not allowed on observer stream",
                        }));
                        if socket.send(Message::Text(err)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                }
            }
        }
    }

    let gids: Vec<Uuid> = group_streams.keys().copied().collect();
    drop(group_streams);
    for gid in gids {
        state.events.cleanup_group_if_idle(gid);
    }
}

async fn handle_observer_command(
    socket: &mut WebSocket,
    state: &AppState,
    group_streams: &mut StreamMap<Uuid, BroadcastStream<Utf8Bytes>>,
    forum_stream: &mut Option<BroadcastStream<Utf8Bytes>>,
    raw: &str,
) -> bool {
    let Ok(cmd) = serde_json::from_str::<ClientAction>(raw) else {
        let err = encode_event(&json!({
            "type": "error",
            "code": "invalid_command",
            "message": "invalid observer JSON command",
        }));
        return socket.send(Message::Text(err)).await.is_ok();
    };

    match cmd.action.as_str() {
        "ping" => {
            let pong = encode_event(&json!({ "type": "pong" }));
            socket.send(Message::Text(pong)).await.is_ok()
        }
        "subscribe" => {
            for gid in cmd.groups {
                if !group_streams.contains_key(&gid) && group_streams.len() >= MAX_OBSERVER_GROUPS {
                    let err = encode_event(&json!({
                        "type": "error",
                        "code": "subscription_limit",
                        "message": "exceeded maximum subscribed groups per observer connection",
                    }));
                    return socket.send(Message::Text(err)).await.is_ok();
                }
                if !group_streams.contains_key(&gid) {
                    group_streams.insert(gid, BroadcastStream::new(state.events.subscribe_group(gid)));
                }
            }
            if cmd.forum == Some(true) && forum_stream.is_none() {
                *forum_stream = Some(BroadcastStream::new(state.events.subscribe_forum()));
            }
            let ack = encode_event(&json!({
                "type": "subscribed",
                "groups": group_streams.keys().copied().collect::<Vec<_>>(),
                "forum": forum_stream.is_some(),
            }));
            socket.send(Message::Text(ack)).await.is_ok()
        }
        "unsubscribe" => {
            for gid in cmd.groups {
                if group_streams.remove(&gid).is_some() {
                    state.events.cleanup_group_if_idle(gid);
                }
            }
            if cmd.forum == Some(true) {
                *forum_stream = None;
            }
            let ack = encode_event(&json!({
                "type": "subscribed",
                "groups": group_streams.keys().copied().collect::<Vec<_>>(),
                "forum": forum_stream.is_some(),
            }));
            socket.send(Message::Text(ack)).await.is_ok()
        }
        _ => {
            let err = encode_event(&json!({
                "type": "error",
                "code": "read_only_stream",
                "message": "observer stream only allows subscribe, unsubscribe, and ping",
            }));
            socket.send(Message::Text(err)).await.is_ok()
        }
    }
}
