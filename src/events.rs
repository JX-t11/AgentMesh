use axum::extract::ws::Utf8Bytes;
use dashmap::DashMap;
use serde::Serialize;
use serde_json::json;
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub enum AgentSignal {
    Frame(Utf8Bytes),
    JoinGroup { group_id: Uuid, frame: Utf8Bytes },
    LeaveGroup { group_id: Uuid, frame: Utf8Bytes },
    Revoke,
}

pub struct EventHub {
    capacity: usize,
    group_channels: DashMap<Uuid, broadcast::Sender<Utf8Bytes>>,
    agent_channels: DashMap<Uuid, broadcast::Sender<AgentSignal>>,
    forum_public_tx: broadcast::Sender<Utf8Bytes>,
    forum_all_tx: broadcast::Sender<Utf8Bytes>,
}

impl EventHub {
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        let (forum_public_tx, _) = broadcast::channel(cap);
        let (forum_all_tx, _) = broadcast::channel(cap);
        Self {
            capacity: cap,
            group_channels: DashMap::new(),
            agent_channels: DashMap::new(),
            forum_public_tx,
            forum_all_tx,
        }
    }

    pub fn subscribe_group(&self, group_id: Uuid) -> broadcast::Receiver<Utf8Bytes> {
        self.group_channels
            .entry(group_id)
            .or_insert_with(|| broadcast::channel(self.capacity).0)
            .subscribe()
    }

    pub fn publish_group(&self, group_id: Uuid, frame: Utf8Bytes) {
        if let Some(tx) = self.group_channels.get(&group_id) {
            let _ = tx.send(frame);
        }
    }

    pub fn cleanup_group_if_idle(&self, group_id: Uuid) {
        self.group_channels
            .remove_if(&group_id, |_, tx| tx.receiver_count() == 0);
    }

    pub fn subscribe_agent(&self, agent_id: Uuid) -> broadcast::Receiver<AgentSignal> {
        self.agent_channels
            .entry(agent_id)
            .or_insert_with(|| broadcast::channel(self.capacity).0)
            .subscribe()
    }

    pub fn send_agent(&self, agent_id: Uuid, signal: AgentSignal) {
        if let Some(tx) = self.agent_channels.get(&agent_id) {
            let _ = tx.send(signal);
        }
    }

    pub fn cleanup_agent_if_idle(&self, agent_id: Uuid) {
        self.agent_channels
            .remove_if(&agent_id, |_, tx| tx.receiver_count() == 0);
    }

    pub fn subscribe_forum(&self, include_platform: bool) -> broadcast::Receiver<Utf8Bytes> {
        if include_platform {
            self.forum_all_tx.subscribe()
        } else {
            self.forum_public_tx.subscribe()
        }
    }

    pub fn publish_forum(&self, frame: Utf8Bytes) {
        self.publish_forum_scoped(frame, true);
    }

    pub fn publish_forum_scoped(&self, frame: Utf8Bytes, is_public: bool) {
        if is_public {
            let _ = self.forum_public_tx.send(frame.clone());
        }
        let _ = self.forum_all_tx.send(frame);
    }

    #[cfg(test)]
    pub fn active_group_channel_count(&self) -> usize {
        self.group_channels.len()
    }
}

/// 单次 JSON 序列化并转为引用计数的 `Utf8Bytes`，供任意数量订阅者零拷贝扇出。
pub fn encode_event<T: Serialize>(event: &T) -> Utf8Bytes {
    let raw = serde_json::to_string(event).expect("event JSON serialization should not fail");
    Utf8Bytes::from(raw)
}

pub fn resync_frame(scope: &str, scope_id: Option<Uuid>, dropped: u64) -> Utf8Bytes {
    encode_event(&json!({
        "type": "resync_required",
        "scope": scope,
        "scope_id": scope_id,
        "dropped": dropped,
    }))
}

#[cfg(test)]
mod tests {
    use tokio::sync::broadcast::error::RecvError;

    use super::*;

    #[tokio::test]
    async fn single_serialization_shares_underlying_buffer_and_cleans_idle_channels() {
        let hub = EventHub::new(8);
        let group_id = Uuid::new_v4();

        let mut rx1 = hub.subscribe_group(group_id);
        let mut rx2 = hub.subscribe_group(group_id);
        assert_eq!(hub.active_group_channel_count(), 1);

        let frame = encode_event(&json!({ "type": "group_message", "seq": 1 }));
        let src_ptr = frame.as_str().as_ptr();
        hub.publish_group(group_id, frame);

        let f1 = rx1.recv().await.unwrap();
        let f2 = rx2.recv().await.unwrap();

        assert_eq!(f1.as_str().as_ptr(), src_ptr);
        assert_eq!(f2.as_str().as_ptr(), src_ptr);

        drop(rx1);
        hub.cleanup_group_if_idle(group_id);
        assert_eq!(hub.active_group_channel_count(), 1);

        drop(rx2);
        hub.cleanup_group_if_idle(group_id);
        assert_eq!(hub.active_group_channel_count(), 0);
    }

    #[tokio::test]
    async fn slow_consumer_triggers_lagged_without_blocking_fast_consumer_or_publisher() {
        let hub = EventHub::new(4);
        let group_id = Uuid::new_v4();

        let mut fast_rx = hub.subscribe_group(group_id);
        let mut slow_rx = hub.subscribe_group(group_id);

        for seq in 1..=7 {
            hub.publish_group(group_id, encode_event(&json!({ "seq": seq })));
            let msg = fast_rx.recv().await.unwrap();
            assert!(msg.as_str().contains(&format!("\"seq\":{seq}")));
        }

        match slow_rx.recv().await {
            Err(RecvError::Lagged(dropped)) => assert_eq!(dropped, 3),
            other => panic!("expected Lagged(3), got {other:?}"),
        }

        let next = slow_rx.recv().await.unwrap();
        assert!(next.as_str().contains("\"seq\":4"));
    }

    #[tokio::test]
    async fn forum_visibility_channels_isolate_platform_events_from_public_subscribers() {
        let hub = EventHub::new(8);
        let mut pub_rx = hub.subscribe_forum(false);
        let mut all_rx = hub.subscribe_forum(true);

        hub.publish_forum_scoped(encode_event(&json!({ "post": "internal" })), false);
        assert!(pub_rx.try_recv().is_err());
        assert!(all_rx.recv().await.unwrap().as_str().contains("internal"));

        hub.publish_forum_scoped(encode_event(&json!({ "post": "public" })), true);
        assert!(pub_rx.recv().await.unwrap().as_str().contains("public"));
        assert!(all_rx.recv().await.unwrap().as_str().contains("public"));
    }
}
