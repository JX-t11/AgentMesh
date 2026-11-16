use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{generate_agent_token, AdminAuth, AgentAuth, AgentPrincipal};
use crate::domain::types::{DescriptionText, ShortName, Slug};
use crate::error::{AppError, AppJson};
use crate::events::AgentSignal;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct RegisterAgentRequest {
    pub slug: Slug,
    pub display_name: ShortName,
    pub framework: Slug,
    #[serde(default)]
    pub description: DescriptionText,
}

#[derive(Serialize)]
pub struct IssuedAgentResponse {
    pub agent: AgentView,
    pub token: String,
}

#[derive(Serialize)]
pub struct AgentEnvelope {
    pub agent: AgentView,
}

#[derive(Serialize)]
pub struct AgentListResponse {
    pub agents: Vec<AgentView>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AgentView {
    pub id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub framework: String,
    pub description: String,
    pub is_revoked: bool,
    pub created_at: DateTime<Utc>,
}

pub async fn register_agent(
    _admin: AdminAuth,
    State(state): State<AppState>,
    AppJson(req): AppJson<RegisterAgentRequest>,
) -> Result<(StatusCode, Json<IssuedAgentResponse>), AppError> {
    let id = Uuid::new_v4();
    let (token, token_hash) = generate_agent_token();

    let agent = sqlx::query_as::<_, AgentView>(
        "INSERT INTO agents (id, slug, display_name, framework, description, token_sha256)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, slug, display_name, framework, description, (revoked_at IS NOT NULL) AS is_revoked, created_at",
    )
    .bind(id)
    .bind(req.slug.as_str())
    .bind(req.display_name.as_str())
    .bind(req.framework.as_str())
    .bind(req.description.as_str())
    .bind(token_hash.as_slice())
    .fetch_one(&state.db)
    .await
    .map_err(map_unique_slug_conflict)?;

    state.auth_cache.upsert(
        token_hash,
        AgentPrincipal {
            id: agent.id,
            slug: agent.slug.clone(),
            display_name: agent.display_name.clone(),
            framework: agent.framework.clone(),
        },
    );

    Ok((StatusCode::CREATED, Json(IssuedAgentResponse { agent, token })))
}

pub async fn rotate_agent_token(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(agent_id): Path<Uuid>,
) -> Result<Json<IssuedAgentResponse>, AppError> {
    let (token, token_hash) = generate_agent_token();

    let agent = sqlx::query_as::<_, AgentView>(
        "UPDATE agents
         SET token_sha256 = $2, revoked_at = NULL
         WHERE id = $1
         RETURNING id, slug, display_name, framework, description, (revoked_at IS NOT NULL) AS is_revoked, created_at",
    )
    .bind(agent_id)
    .bind(token_hash.as_slice())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    state.auth_cache.upsert(
        token_hash,
        AgentPrincipal {
            id: agent.id,
            slug: agent.slug.clone(),
            display_name: agent.display_name.clone(),
            framework: agent.framework.clone(),
        },
    );
    state.events.send_agent(agent_id, AgentSignal::Revoke);

    Ok(Json(IssuedAgentResponse { agent, token }))
}

pub async fn revoke_agent(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(agent_id): Path<Uuid>,
) -> Result<Json<AgentEnvelope>, AppError> {
    let agent = sqlx::query_as::<_, AgentView>(
        "UPDATE agents
         SET token_sha256 = NULL, revoked_at = COALESCE(revoked_at, NOW())
         WHERE id = $1
         RETURNING id, slug, display_name, framework, description, (revoked_at IS NOT NULL) AS is_revoked, created_at",
    )
    .bind(agent_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    state.auth_cache.revoke(agent_id);
    state.events.send_agent(agent_id, AgentSignal::Revoke);

    Ok(Json(AgentEnvelope { agent }))
}

pub async fn list_agents(State(state): State<AppState>) -> Result<Json<AgentListResponse>, AppError> {
    let agents = sqlx::query_as::<_, AgentView>(
        "SELECT id, slug, display_name, framework, description, (revoked_at IS NOT NULL) AS is_revoked, created_at
         FROM agents
         ORDER BY created_at ASC, id ASC",
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(AgentListResponse { agents }))
}

pub async fn get_me(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
) -> Result<Json<AgentEnvelope>, AppError> {
    let agent = sqlx::query_as::<_, AgentView>(
        "SELECT id, slug, display_name, framework, description, (revoked_at IS NOT NULL) AS is_revoked, created_at
         FROM agents
         WHERE id = $1",
    )
    .bind(principal.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Unauthorized("agent no longer exists".into()))?;

    Ok(Json(AgentEnvelope { agent }))
}

fn map_unique_slug_conflict(err: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &err {
        if db_err.code().as_deref() == Some("23505") {
            return AppError::Conflict("agent slug already exists".into());
        }
    }
    AppError::from(err)
}
