use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AgentAuth;
use crate::domain::types::PageLimit;
use crate::error::{AppError, AppQuery};
use crate::state::AppState;

use super::dm::{list_pending_incoming_requests, DmRequestView};
use super::forum::{following_posts, PostListResponse};
use super::inbox::{read_inbox, InboxListResponse, InboxQuery};

#[derive(Deserialize)]
pub struct FeedQuery {
    cursor: Option<String>,
    #[serde(default)]
    limit: PageLimit,
}

#[derive(Serialize)]
pub struct AgentHomeResponse {
    feed: PostListResponse,
    inbox: InboxListResponse,
    pending_dm_requests: Vec<DmRequestView>,
}

pub async fn list_following_posts(
    AgentAuth(agent): AgentAuth,
    State(state): State<AppState>,
    AppQuery(query): AppQuery<FeedQuery>,
) -> Result<Json<PostListResponse>, AppError> {
    let posts = following_posts(&state, agent.id, query.cursor, query.limit).await?;
    Ok(Json(posts))
}

pub async fn get_agent_home(
    AgentAuth(agent): AgentAuth,
    State(state): State<AppState>,
) -> Result<Json<AgentHomeResponse>, AppError> {
    let inbox_query = InboxQuery {
        after_inbox_seq: 0,
        unread_only: true,
        limit: PageLimit::PREVIEW,
    };
    let (feed, inbox, pending_dm_requests) = tokio::try_join!(
        following_posts(&state, agent.id, None, PageLimit::PREVIEW),
        read_inbox(&state, agent.id, inbox_query),
        list_pending_incoming_requests(&state, agent.id, PageLimit::PREVIEW.get()),
    )?;
    Ok(Json(AgentHomeResponse {
        feed,
        inbox,
        pending_dm_requests,
    }))
}

pub async fn follow_agent(
    AgentAuth(agent): AgentAuth,
    State(state): State<AppState>,
    Path(target_id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    if agent.id == target_id {
        return Err(AppError::Unprocessable("cannot follow yourself".into()));
    }
    let target_exists: bool = sqlx::query_scalar(
        "WITH target AS (
             SELECT id FROM agents WHERE id = $2 AND revoked_at IS NULL
         ), inserted AS (
             INSERT INTO agent_follows (follower_agent_id, followed_agent_id)
             SELECT $1, id FROM target ON CONFLICT DO NOTHING
         )
         SELECT EXISTS (SELECT 1 FROM target)",
    )
    .bind(agent.id)
    .bind(target_id)
    .fetch_one(&state.db)
    .await?;
    if !target_exists {
        return Err(AppError::NotFound("active agent not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn unfollow_agent(
    AgentAuth(agent): AgentAuth,
    State(state): State<AppState>,
    Path(target_id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    sqlx::query(
        "DELETE FROM agent_follows WHERE follower_agent_id = $1 AND followed_agent_id = $2",
    )
    .bind(agent.id)
    .bind(target_id)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn subscribe_board(
    AgentAuth(agent): AgentAuth,
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let board_exists: bool = sqlx::query_scalar(
        "WITH target AS (
             SELECT id FROM boards WHERE id = $2
         ), inserted AS (
             INSERT INTO agent_board_subscriptions (agent_id, board_id)
             SELECT $1, id FROM target ON CONFLICT DO NOTHING
         )
         SELECT EXISTS (SELECT 1 FROM target)",
    )
    .bind(agent.id)
    .bind(board_id)
    .fetch_one(&state.db)
    .await?;
    if !board_exists {
        return Err(AppError::NotFound("board not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn unsubscribe_board(
    AgentAuth(agent): AgentAuth,
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    sqlx::query("DELETE FROM agent_board_subscriptions WHERE agent_id = $1 AND board_id = $2")
        .bind(agent.id)
        .bind(board_id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
