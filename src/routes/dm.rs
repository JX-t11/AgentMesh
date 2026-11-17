use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{AgentAuth, AgentOrOwnerAuth};
use crate::domain::types::{DescriptionText, DmRespondAction};
use crate::error::{AppError, AppJson, AppQuery};
use crate::events::{encode_event, AgentSignal};
use crate::routes::groups::{notify_members_joined, truncate_summary};
use crate::routes::inbox::InboxEventView;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateDmRequestPayload {
    pub target_agent_id: Uuid,
    #[serde(default)]
    pub message: DescriptionText,
}

#[derive(Deserialize)]
pub struct RespondDmRequestPayload {
    pub action: DmRespondAction,
}

#[derive(Deserialize)]
pub struct BlockAgentPayload {
    pub blocked_agent_id: Uuid,
}

#[derive(Deserialize)]
pub struct ListDmRequestsQuery {
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DmRequestView {
    pub id: Uuid,
    pub sender_agent_id: Uuid,
    pub sender_slug: String,
    pub sender_display_name: String,
    pub receiver_agent_id: Uuid,
    pub receiver_slug: String,
    pub receiver_display_name: String,
    pub status: String,
    pub request_message: String,
    pub dm_group_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DmSessionView {
    pub group_id: Uuid,
    pub slug: String,
    pub last_seq: i64,
    pub agent_a_id: Uuid,
    pub agent_a_slug: String,
    pub agent_a_display_name: String,
    pub agent_b_id: Uuid,
    pub agent_b_slug: String,
    pub agent_b_display_name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct DmRequestEnvelope {
    pub request: DmRequestView,
}

#[derive(Serialize)]
pub struct DmRequestListResponse {
    pub requests: Vec<DmRequestView>,
}

#[derive(Serialize)]
pub struct DmSessionListResponse {
    pub sessions: Vec<DmSessionView>,
}

pub async fn create_dm_request(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
    AppJson(req): AppJson<CreateDmRequestPayload>,
) -> Result<(StatusCode, Json<DmRequestEnvelope>), AppError> {
    if req.target_agent_id == principal.id {
        return Err(AppError::Unprocessable(
            "cannot initiate a DM request with yourself".into(),
        ));
    }

    let target_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agents WHERE id = $1)")
            .bind(req.target_agent_id)
            .fetch_one(&state.db)
            .await?;
    if !target_exists {
        return Err(AppError::NotFound("target agent not found".into()));
    }

    let is_blocked: bool = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM agent_dm_blocks
             WHERE (blocker_agent_id = $1 AND blocked_agent_id = $2)
                OR (blocker_agent_id = $2 AND blocked_agent_id = $1)
         )",
    )
    .bind(req.target_agent_id)
    .bind(principal.id)
    .fetch_one(&state.db)
    .await?;
    if is_blocked {
        return Err(AppError::Forbidden(
            "DM request rejected by block policy".into(),
        ));
    }

    let pair_key = canonical_dm_pair_key(principal.id, req.target_agent_id);
    if let Some(existing_dm_gid) =
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM groups WHERE dm_pair_key = $1")
            .bind(&pair_key)
            .fetch_optional(&state.db)
            .await?
    {
        if let Some(accepted_req) =
            fetch_latest_pair_request(&state, principal.id, req.target_agent_id).await?
        {
            return Ok((
                StatusCode::OK,
                Json(DmRequestEnvelope {
                    request: accepted_req,
                }),
            ));
        }
        let now = Utc::now();
        let target_meta: (String, String) =
            sqlx::query_as("SELECT slug, display_name FROM agents WHERE id = $1")
                .bind(req.target_agent_id)
                .fetch_one(&state.db)
                .await?;
        return Ok((
            StatusCode::OK,
            Json(DmRequestEnvelope {
                request: DmRequestView {
                    id: existing_dm_gid,
                    sender_agent_id: principal.id,
                    sender_slug: principal.slug.clone(),
                    sender_display_name: principal.display_name.clone(),
                    receiver_agent_id: req.target_agent_id,
                    receiver_slug: target_meta.0,
                    receiver_display_name: target_meta.1,
                    status: "accepted".into(),
                    request_message: String::new(),
                    dm_group_id: Some(existing_dm_gid),
                    created_at: now,
                    updated_at: now,
                },
            }),
        ));
    }

    if let Some(pending) = fetch_pending_request(&state, principal.id, req.target_agent_id).await? {
        return Ok((StatusCode::OK, Json(DmRequestEnvelope { request: pending })));
    }

    let request_id = Uuid::new_v4();
    let summary = if req.message.as_str().is_empty() {
        format!("DM handshake request from @{}", principal.slug)
    } else {
        truncate_summary(
            &format!(
                "DM request from @{}: {}",
                principal.slug,
                req.message.as_str()
            ),
            200,
        )
    };

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO dm_requests (id, sender_agent_id, receiver_agent_id, status, request_message)
         VALUES ($1, $2, $3, 'pending', $4)",
    )
    .bind(request_id)
    .bind(principal.id)
    .bind(req.target_agent_id)
    .bind(req.message.as_str())
    .execute(&mut *tx)
    .await?;

    let (inbox_seq, inbox_created_at): (i64, DateTime<Utc>) = sqlx::query_as(
        "WITH bumped AS (
             UPDATE agents
             SET last_inbox_seq = last_inbox_seq + 1
             WHERE id = $1
             RETURNING last_inbox_seq
         )
         INSERT INTO inbox_events (
             recipient_agent_id, inbox_seq, kind, source_id, actor_agent_id, summary
         )
         SELECT $1, b.last_inbox_seq, 'dm_request', $2, $3, $4
         FROM bumped b
         RETURNING inbox_seq, created_at",
    )
    .bind(req.target_agent_id)
    .bind(request_id)
    .bind(principal.id)
    .bind(&summary)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    let inbox_view = InboxEventView {
        inbox_seq,
        kind: "dm_request".into(),
        source_id: request_id,
        group_id: None,
        post_id: None,
        actor_agent_id: principal.id,
        summary,
        is_acked: false,
        created_at: inbox_created_at,
    };
    let frame = encode_event(&json!({
        "type": "inbox_event",
        "event": inbox_view,
    }));
    state
        .events
        .send_agent(req.target_agent_id, AgentSignal::Frame(frame));

    let request = fetch_dm_request_view(&state, request_id).await?;
    Ok((StatusCode::CREATED, Json(DmRequestEnvelope { request })))
}

pub async fn respond_dm_request(
    caller: AgentOrOwnerAuth,
    State(state): State<AppState>,
    Path(request_id): Path<Uuid>,
    AppJson(payload): AppJson<RespondDmRequestPayload>,
) -> Result<Json<DmRequestEnvelope>, AppError> {
    #[derive(FromRow)]
    struct TargetReqMeta {
        sender_agent_id: Uuid,
        sender_slug: String,
        receiver_agent_id: Uuid,
        receiver_slug: String,
        receiver_owner_user_id: Option<Uuid>,
        status: String,
    }

    let meta = sqlx::query_as::<_, TargetReqMeta>(
        "SELECT r.sender_agent_id, sa.slug AS sender_slug,
                r.receiver_agent_id, ra.slug AS receiver_slug,
                ra.owner_user_id AS receiver_owner_user_id,
                r.status
         FROM dm_requests r
         JOIN agents sa ON sa.id = r.sender_agent_id
         JOIN agents ra ON ra.id = r.receiver_agent_id
         WHERE r.id = $1",
    )
    .bind(request_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("DM request not found".into()))?;

    match &caller {
        AgentOrOwnerAuth::Admin => {}
        AgentOrOwnerAuth::Agent(agent) => {
            if agent.id != meta.receiver_agent_id {
                return Err(AppError::Forbidden(
                    "only the receiving agent or its owner can respond to this DM request".into(),
                ));
            }
        }
        AgentOrOwnerAuth::User(user) => {
            if meta.receiver_owner_user_id != Some(user.id) {
                return Err(AppError::Forbidden(
                    "only the receiving agent or its owner can respond to this DM request".into(),
                ));
            }
        }
    }

    if meta.status != "pending" {
        if meta.status == "accepted" && payload.action == DmRespondAction::Accept {
            let request = fetch_dm_request_view(&state, request_id).await?;
            return Ok(Json(DmRequestEnvelope { request }));
        }
        return Err(AppError::Conflict(
            "DM request has already been resolved".into(),
        ));
    }

    match payload.action {
        DmRespondAction::Accept => {
            let pair_key = canonical_dm_pair_key(meta.sender_agent_id, meta.receiver_agent_id);
            let candidate_group_id = Uuid::new_v4();
            let candidate_slug = format!("dm-{}", Uuid::new_v4().simple());
            let dm_name = format!("@{} <-> @{}", meta.sender_slug, meta.receiver_slug);
            let summary = format!("DM request accepted by @{}", meta.receiver_slug);

            let mut tx = state.db.begin().await?;
            let (dm_group_id, dm_slug): (Uuid, String) = sqlx::query_as(
                "INSERT INTO groups (
                     id, slug, name, description, is_dm, visibility, join_policy, dm_pair_key
                 )
                 VALUES ($1, $2, $3, 'Direct message channel', TRUE, 'private', 'invite_only', $4)
                 ON CONFLICT (dm_pair_key) DO UPDATE SET dm_pair_key = EXCLUDED.dm_pair_key
                 RETURNING id, slug",
            )
            .bind(candidate_group_id)
            .bind(&candidate_slug)
            .bind(&dm_name)
            .bind(&pair_key)
            .fetch_one(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO group_members (group_id, agent_id)
                 VALUES ($1, $2), ($1, $3)
                 ON CONFLICT (group_id, agent_id) DO NOTHING",
            )
            .bind(dm_group_id)
            .bind(meta.sender_agent_id)
            .bind(meta.receiver_agent_id)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                "UPDATE dm_requests
                 SET status = 'accepted', dm_group_id = $2, updated_at = NOW()
                 WHERE status = 'pending'
                   AND (
                       id = $1
                       OR (sender_agent_id = $3 AND receiver_agent_id = $4)
                   )",
            )
            .bind(request_id)
            .bind(dm_group_id)
            .bind(meta.receiver_agent_id)
            .bind(meta.sender_agent_id)
            .execute(&mut *tx)
            .await?;

            let (inbox_seq, inbox_created_at): (i64, DateTime<Utc>) = sqlx::query_as(
                "WITH bumped AS (
                     UPDATE agents
                     SET last_inbox_seq = last_inbox_seq + 1
                     WHERE id = $1
                     RETURNING last_inbox_seq
                 )
                 INSERT INTO inbox_events (
                     recipient_agent_id, inbox_seq, kind, source_id, group_id, actor_agent_id, summary
                 )
                 SELECT $1, b.last_inbox_seq, 'dm_accepted', $2, $3, $4, $5
                 FROM bumped b
                 RETURNING inbox_seq, created_at",
            )
            .bind(meta.sender_agent_id)
            .bind(request_id)
            .bind(dm_group_id)
            .bind(meta.receiver_agent_id)
            .bind(&summary)
            .fetch_one(&mut *tx)
            .await?;

            tx.commit().await?;

            notify_members_joined(
                &state,
                dm_group_id,
                &dm_slug,
                &[meta.sender_agent_id, meta.receiver_agent_id],
            );

            let inbox_view = InboxEventView {
                inbox_seq,
                kind: "dm_accepted".into(),
                source_id: request_id,
                group_id: Some(dm_group_id),
                post_id: None,
                actor_agent_id: meta.receiver_agent_id,
                summary,
                is_acked: false,
                created_at: inbox_created_at,
            };
            let frame = encode_event(&json!({
                "type": "inbox_event",
                "event": inbox_view,
            }));
            state
                .events
                .send_agent(meta.sender_agent_id, AgentSignal::Frame(frame));
        }
        DmRespondAction::Reject => {
            let summary = format!("DM request rejected by @{}", meta.receiver_slug);
            let mut tx = state.db.begin().await?;
            sqlx::query(
                "UPDATE dm_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1",
            )
            .bind(request_id)
            .execute(&mut *tx)
            .await?;

            let (inbox_seq, inbox_created_at): (i64, DateTime<Utc>) = sqlx::query_as(
                "WITH bumped AS (
                     UPDATE agents
                     SET last_inbox_seq = last_inbox_seq + 1
                     WHERE id = $1
                     RETURNING last_inbox_seq
                 )
                 INSERT INTO inbox_events (
                     recipient_agent_id, inbox_seq, kind, source_id, actor_agent_id, summary
                 )
                 SELECT $1, b.last_inbox_seq, 'dm_rejected', $2, $3, $4
                 FROM bumped b
                 RETURNING inbox_seq, created_at",
            )
            .bind(meta.sender_agent_id)
            .bind(request_id)
            .bind(meta.receiver_agent_id)
            .bind(&summary)
            .fetch_one(&mut *tx)
            .await?;

            tx.commit().await?;

            let inbox_view = InboxEventView {
                inbox_seq,
                kind: "dm_rejected".into(),
                source_id: request_id,
                group_id: None,
                post_id: None,
                actor_agent_id: meta.receiver_agent_id,
                summary,
                is_acked: false,
                created_at: inbox_created_at,
            };
            let frame = encode_event(&json!({
                "type": "inbox_event",
                "event": inbox_view,
            }));
            state
                .events
                .send_agent(meta.sender_agent_id, AgentSignal::Frame(frame));
        }
        DmRespondAction::Block => {
            let mut tx = state.db.begin().await?;
            sqlx::query(
                "UPDATE dm_requests SET status = 'blocked', updated_at = NOW() WHERE id = $1",
            )
            .bind(request_id)
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                "INSERT INTO agent_dm_blocks (blocker_agent_id, blocked_agent_id)
                 VALUES ($1, $2)
                 ON CONFLICT (blocker_agent_id, blocked_agent_id) DO NOTHING",
            )
            .bind(meta.receiver_agent_id)
            .bind(meta.sender_agent_id)
            .execute(&mut *tx)
            .await?;

            tx.commit().await?;
        }
    }

    let request = fetch_dm_request_view(&state, request_id).await?;
    Ok(Json(DmRequestEnvelope { request }))
}

pub async fn block_agent_dm(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
    AppJson(payload): AppJson<BlockAgentPayload>,
) -> Result<StatusCode, AppError> {
    if payload.blocked_agent_id == principal.id {
        return Err(AppError::Unprocessable("cannot block yourself".into()));
    }

    let target_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agents WHERE id = $1)")
            .bind(payload.blocked_agent_id)
            .fetch_one(&state.db)
            .await?;
    if !target_exists {
        return Err(AppError::NotFound("target agent not found".into()));
    }

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO agent_dm_blocks (blocker_agent_id, blocked_agent_id)
         VALUES ($1, $2)
         ON CONFLICT (blocker_agent_id, blocked_agent_id) DO NOTHING",
    )
    .bind(principal.id)
    .bind(payload.blocked_agent_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE dm_requests
         SET status = 'blocked', updated_at = NOW()
         WHERE sender_agent_id = $1 AND receiver_agent_id = $2 AND status = 'pending'",
    )
    .bind(payload.blocked_agent_id)
    .bind(principal.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn unblock_agent_dm(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
    Path(blocked_agent_id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    sqlx::query(
        "DELETE FROM agent_dm_blocks WHERE blocker_agent_id = $1 AND blocked_agent_id = $2",
    )
    .bind(principal.id)
    .bind(blocked_agent_id)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_dm_requests(
    caller: AgentOrOwnerAuth,
    State(state): State<AppState>,
    AppQuery(query): AppQuery<ListDmRequestsQuery>,
) -> Result<Json<DmRequestListResponse>, AppError> {
    let status_filter = query.status.as_deref();

    let requests = match caller {
        AgentOrOwnerAuth::Admin => {
            sqlx::query_as::<_, DmRequestView>(
                "SELECT r.id, r.sender_agent_id, sa.slug AS sender_slug, sa.display_name AS sender_display_name,
                        r.receiver_agent_id, ra.slug AS receiver_slug, ra.display_name AS receiver_display_name,
                        r.status, r.request_message, r.dm_group_id, r.created_at, r.updated_at
                 FROM dm_requests r
                 JOIN agents sa ON sa.id = r.sender_agent_id
                 JOIN agents ra ON ra.id = r.receiver_agent_id
                 WHERE ($1::text IS NULL OR r.status = $1)
                 ORDER BY r.created_at DESC, r.id DESC
                 LIMIT 100",
            )
            .bind(status_filter)
            .fetch_all(&state.db)
            .await?
        }
        AgentOrOwnerAuth::Agent(agent) => {
            sqlx::query_as::<_, DmRequestView>(
                "SELECT r.id, r.sender_agent_id, sa.slug AS sender_slug, sa.display_name AS sender_display_name,
                        r.receiver_agent_id, ra.slug AS receiver_slug, ra.display_name AS receiver_display_name,
                        r.status, r.request_message, r.dm_group_id, r.created_at, r.updated_at
                 FROM dm_requests r
                 JOIN agents sa ON sa.id = r.sender_agent_id
                 JOIN agents ra ON ra.id = r.receiver_agent_id
                 WHERE (r.sender_agent_id = $1 OR r.receiver_agent_id = $1)
                   AND ($2::text IS NULL OR r.status = $2)
                 ORDER BY r.created_at DESC, r.id DESC
                 LIMIT 100",
            )
            .bind(agent.id)
            .bind(status_filter)
            .fetch_all(&state.db)
            .await?
        }
        AgentOrOwnerAuth::User(user) => {
            sqlx::query_as::<_, DmRequestView>(
                "SELECT r.id, r.sender_agent_id, sa.slug AS sender_slug, sa.display_name AS sender_display_name,
                        r.receiver_agent_id, ra.slug AS receiver_slug, ra.display_name AS receiver_display_name,
                        r.status, r.request_message, r.dm_group_id, r.created_at, r.updated_at
                 FROM dm_requests r
                 JOIN agents sa ON sa.id = r.sender_agent_id
                 JOIN agents ra ON ra.id = r.receiver_agent_id
                 WHERE (sa.owner_user_id = $1 OR ra.owner_user_id = $1)
                   AND ($2::text IS NULL OR r.status = $2)
                 ORDER BY r.created_at DESC, r.id DESC
                 LIMIT 100",
            )
            .bind(user.id)
            .bind(status_filter)
            .fetch_all(&state.db)
            .await?
        }
    };

    Ok(Json(DmRequestListResponse { requests }))
}

pub async fn list_dm_sessions(
    caller: AgentOrOwnerAuth,
    State(state): State<AppState>,
) -> Result<Json<DmSessionListResponse>, AppError> {
    let sessions = match caller {
        AgentOrOwnerAuth::Admin => {
            sqlx::query_as::<_, DmSessionView>(
                "SELECT g.id AS group_id, g.slug, g.last_seq,
                        a1.id AS agent_a_id, a1.slug AS agent_a_slug, a1.display_name AS agent_a_display_name,
                        a2.id AS agent_b_id, a2.slug AS agent_b_slug, a2.display_name AS agent_b_display_name,
                        g.created_at
                 FROM groups g
                 JOIN group_members gm1 ON gm1.group_id = g.id
                 JOIN group_members gm2 ON gm2.group_id = g.id AND gm1.agent_id < gm2.agent_id
                 JOIN agents a1 ON a1.id = gm1.agent_id
                 JOIN agents a2 ON a2.id = gm2.agent_id
                 WHERE g.is_dm = TRUE
                 ORDER BY g.created_at DESC, g.id DESC",
            )
            .fetch_all(&state.db)
            .await?
        }
        AgentOrOwnerAuth::Agent(agent) => {
            sqlx::query_as::<_, DmSessionView>(
                "SELECT g.id AS group_id, g.slug, g.last_seq,
                        a1.id AS agent_a_id, a1.slug AS agent_a_slug, a1.display_name AS agent_a_display_name,
                        a2.id AS agent_b_id, a2.slug AS agent_b_slug, a2.display_name AS agent_b_display_name,
                        g.created_at
                 FROM groups g
                 JOIN group_members gm1 ON gm1.group_id = g.id
                 JOIN group_members gm2 ON gm2.group_id = g.id AND gm1.agent_id < gm2.agent_id
                 JOIN agents a1 ON a1.id = gm1.agent_id
                 JOIN agents a2 ON a2.id = gm2.agent_id
                 WHERE g.is_dm = TRUE AND (a1.id = $1 OR a2.id = $1)
                 ORDER BY g.created_at DESC, g.id DESC",
            )
            .bind(agent.id)
            .fetch_all(&state.db)
            .await?
        }
        AgentOrOwnerAuth::User(user) => {
            sqlx::query_as::<_, DmSessionView>(
                "SELECT g.id AS group_id, g.slug, g.last_seq,
                        a1.id AS agent_a_id, a1.slug AS agent_a_slug, a1.display_name AS agent_a_display_name,
                        a2.id AS agent_b_id, a2.slug AS agent_b_slug, a2.display_name AS agent_b_display_name,
                        g.created_at
                 FROM groups g
                 JOIN group_members gm1 ON gm1.group_id = g.id
                 JOIN group_members gm2 ON gm2.group_id = g.id AND gm1.agent_id < gm2.agent_id
                 JOIN agents a1 ON a1.id = gm1.agent_id
                 JOIN agents a2 ON a2.id = gm2.agent_id
                 WHERE g.is_dm = TRUE AND (a1.owner_user_id = $1 OR a2.owner_user_id = $1)
                 ORDER BY g.created_at DESC, g.id DESC",
            )
            .bind(user.id)
            .fetch_all(&state.db)
            .await?
        }
    };

    Ok(Json(DmSessionListResponse { sessions }))
}

fn canonical_dm_pair_key(a: Uuid, b: Uuid) -> String {
    if a < b {
        format!("{a}:{b}")
    } else {
        format!("{b}:{a}")
    }
}

async fn fetch_dm_request_view(
    state: &AppState,
    request_id: Uuid,
) -> Result<DmRequestView, AppError> {
    sqlx::query_as::<_, DmRequestView>(
        "SELECT r.id, r.sender_agent_id, sa.slug AS sender_slug, sa.display_name AS sender_display_name,
                r.receiver_agent_id, ra.slug AS receiver_slug, ra.display_name AS receiver_display_name,
                r.status, r.request_message, r.dm_group_id, r.created_at, r.updated_at
         FROM dm_requests r
         JOIN agents sa ON sa.id = r.sender_agent_id
         JOIN agents ra ON ra.id = r.receiver_agent_id
         WHERE r.id = $1",
    )
    .bind(request_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("DM request not found".into()))
}

async fn fetch_pending_request(
    state: &AppState,
    sender_id: Uuid,
    receiver_id: Uuid,
) -> Result<Option<DmRequestView>, sqlx::Error> {
    sqlx::query_as::<_, DmRequestView>(
        "SELECT r.id, r.sender_agent_id, sa.slug AS sender_slug, sa.display_name AS sender_display_name,
                r.receiver_agent_id, ra.slug AS receiver_slug, ra.display_name AS receiver_display_name,
                r.status, r.request_message, r.dm_group_id, r.created_at, r.updated_at
         FROM dm_requests r
         JOIN agents sa ON sa.id = r.sender_agent_id
         JOIN agents ra ON ra.id = r.receiver_agent_id
         WHERE r.sender_agent_id = $1 AND r.receiver_agent_id = $2 AND r.status = 'pending'
         LIMIT 1",
    )
    .bind(sender_id)
    .bind(receiver_id)
    .fetch_optional(&state.db)
    .await
}

async fn fetch_latest_pair_request(
    state: &AppState,
    a: Uuid,
    b: Uuid,
) -> Result<Option<DmRequestView>, sqlx::Error> {
    sqlx::query_as::<_, DmRequestView>(
        "SELECT r.id, r.sender_agent_id, sa.slug AS sender_slug, sa.display_name AS sender_display_name,
                r.receiver_agent_id, ra.slug AS receiver_slug, ra.display_name AS receiver_display_name,
                r.status, r.request_message, r.dm_group_id, r.created_at, r.updated_at
         FROM dm_requests r
         JOIN agents sa ON sa.id = r.sender_agent_id
         JOIN agents ra ON ra.id = r.receiver_agent_id
         WHERE ((r.sender_agent_id = $1 AND r.receiver_agent_id = $2)
             OR (r.sender_agent_id = $2 AND r.receiver_agent_id = $1))
           AND r.status = 'accepted'
         ORDER BY r.updated_at DESC
         LIMIT 1",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(&state.db)
    .await
}
