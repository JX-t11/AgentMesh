use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::AgentAuth;
use crate::domain::types::PageLimit;
use crate::error::{AppError, AppJson, AppQuery};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct InboxQuery {
    #[serde(default)]
    pub after_inbox_seq: i64,
    #[serde(default)]
    pub unread_only: bool,
    #[serde(default)]
    pub limit: PageLimit,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct InboxEventView {
    pub inbox_seq: i64,
    pub kind: String,
    pub source_id: Uuid,
    pub group_id: Option<Uuid>,
    pub post_id: Option<Uuid>,
    pub actor_agent_id: Uuid,
    pub summary: String,
    pub is_acked: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct InboxListResponse {
    pub items: Vec<InboxEventView>,
    pub next_after_inbox_seq: i64,
    pub acked_inbox_seq: i64,
    pub has_more: bool,
}

#[derive(Deserialize)]
pub struct AckInboxRequest {
    pub up_to_inbox_seq: i64,
}

#[derive(Serialize)]
pub struct AckInboxResponse {
    pub acked_inbox_seq: i64,
}

pub async fn list_inbox(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
    AppQuery(query): AppQuery<InboxQuery>,
) -> Result<Json<InboxListResponse>, AppError> {
    if query.after_inbox_seq < 0 {
        return Err(AppError::BadRequest("after_inbox_seq must be >= 0".into()));
    }

    let fetch_limit = query.limit.get() + 1;
    let acked_inbox_seq: i64 =
        sqlx::query_scalar("SELECT acked_inbox_seq FROM agents WHERE id = $1")
            .bind(principal.id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::Unauthorized("agent not found".into()))?;

    let mut rows = sqlx::query_as::<_, InboxEventView>(
        "SELECT inbox_seq, kind, source_id, group_id, post_id, actor_agent_id, summary,
                (inbox_seq <= $2) AS is_acked, created_at
         FROM inbox_events
         WHERE recipient_agent_id = $1
           AND inbox_seq > $3
           AND (NOT $4 OR inbox_seq > $2)
         ORDER BY inbox_seq ASC
         LIMIT $5",
    )
    .bind(principal.id)
    .bind(acked_inbox_seq)
    .bind(query.after_inbox_seq)
    .bind(query.unread_only)
    .bind(fetch_limit)
    .fetch_all(&state.db)
    .await?;

    let has_more = rows.len() as i64 > query.limit.get();
    if has_more {
        rows.pop();
    }

    let next_after_inbox_seq = rows
        .last()
        .map(|item| item.inbox_seq)
        .unwrap_or(query.after_inbox_seq);

    Ok(Json(InboxListResponse {
        items: rows,
        next_after_inbox_seq,
        acked_inbox_seq,
        has_more,
    }))
}

pub async fn ack_inbox(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
    AppJson(req): AppJson<AckInboxRequest>,
) -> Result<Json<AckInboxResponse>, AppError> {
    if req.up_to_inbox_seq < 0 {
        return Err(AppError::Unprocessable(
            "up_to_inbox_seq must be >= 0".into(),
        ));
    }

    let acked_inbox_seq: i64 = sqlx::query_scalar(
        "UPDATE agents
         SET acked_inbox_seq = GREATEST(acked_inbox_seq, LEAST(last_inbox_seq, $2))
         WHERE id = $1
         RETURNING acked_inbox_seq",
    )
    .bind(principal.id)
    .bind(req.up_to_inbox_seq)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Unauthorized("agent not found".into()))?;

    Ok(Json(AckInboxResponse { acked_inbox_seq }))
}
