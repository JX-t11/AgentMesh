use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, QueryBuilder};
use uuid::Uuid;

use crate::auth::{
    generate_agent_token, AdminAuth, AgentAuth, AgentPrincipal, GovernanceAuth, UserAuth,
};
use crate::domain::types::{
    CapabilityList, DescriptionText, NonEmptyText, PageLimit, ShortName, Slug,
};
use crate::error::{AppError, AppJson, AppQuery};
use crate::events::AgentSignal;
use crate::state::AppState;

use super::{decode_keyset_cursor, encode_keyset_cursor, literal_search_pattern};

const PROFILE_SELECT: &str =
    "SELECT a.id, a.slug, a.display_name, a.framework, a.description, a.capabilities,
            a.owner_user_id, u.username AS owner_username,
            (a.revoked_at IS NOT NULL) AS is_revoked, a.created_at
     FROM agents a LEFT JOIN users u ON u.id = a.owner_user_id";

#[derive(Deserialize)]
pub struct RegisterAgentRequest {
    pub slug: Slug,
    pub display_name: ShortName,
    pub framework: Slug,
    #[serde(default)]
    pub description: DescriptionText,
    #[serde(default)]
    pub capabilities: CapabilityList,
}

#[derive(Deserialize)]
pub struct UpdateAgentRequest {
    pub display_name: Option<ShortName>,
    pub description: Option<DescriptionText>,
    pub capabilities: Option<CapabilityList>,
}

#[derive(Deserialize)]
pub struct ClaimAgentRequest {
    pub agent_token: NonEmptyText<256>,
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

#[derive(Deserialize)]
pub struct SearchAgentsQuery {
    pub q: Option<ShortName>,
    pub framework: Option<Slug>,
    pub capability: Option<NonEmptyText<64>>,
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: PageLimit,
}

#[derive(Serialize)]
pub struct AgentSearchResponse {
    pub agents: Vec<AgentView>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AgentView {
    pub id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub framework: String,
    pub description: String,
    pub capabilities: Vec<String>,
    pub owner_user_id: Option<Uuid>,
    pub owner_username: Option<String>,
    pub is_revoked: bool,
    pub created_at: DateTime<Utc>,
}

pub async fn register_agent(
    _admin: AdminAuth,
    State(state): State<AppState>,
    AppJson(req): AppJson<RegisterAgentRequest>,
) -> Result<(StatusCode, Json<IssuedAgentResponse>), AppError> {
    create_agent_record(&state, req, None).await
}

pub async fn register_autonomous_agent(
    State(state): State<AppState>,
    AppJson(req): AppJson<RegisterAgentRequest>,
) -> Result<(StatusCode, Json<IssuedAgentResponse>), AppError> {
    create_agent_record(&state, req, None).await
}

pub async fn register_my_agent(
    auth: UserAuth,
    State(state): State<AppState>,
    AppJson(req): AppJson<RegisterAgentRequest>,
) -> Result<(StatusCode, Json<IssuedAgentResponse>), AppError> {
    create_agent_record(&state, req, Some(auth.user.id)).await
}

pub async fn claim_my_agent(
    auth: UserAuth,
    State(state): State<AppState>,
    AppJson(req): AppJson<ClaimAgentRequest>,
) -> Result<Json<AgentEnvelope>, AppError> {
    let principal = state
        .auth_cache
        .verify_token(req.agent_token.as_str())
        .ok_or_else(|| AppError::Unauthorized("invalid or revoked agent token".into()))?;

    let claimed = sqlx::query_as::<_, AgentView>(
        "WITH updated AS (
             UPDATE agents
             SET owner_user_id = $2
             WHERE id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2)
             RETURNING id, slug, display_name, framework, description, capabilities,
                       owner_user_id, revoked_at, created_at
         )
         SELECT up.id, up.slug, up.display_name, up.framework, up.description, up.capabilities,
                up.owner_user_id, u.username AS owner_username,
                (up.revoked_at IS NOT NULL) AS is_revoked, up.created_at
         FROM updated up
         LEFT JOIN users u ON u.id = up.owner_user_id",
    )
    .bind(principal.id)
    .bind(auth.user.id)
    .fetch_optional(&state.db)
    .await?;

    if let Some(agent) = claimed {
        return Ok(Json(AgentEnvelope { agent }));
    }

    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agents WHERE id = $1)")
        .bind(principal.id)
        .fetch_one(&state.db)
        .await?;
    if exists {
        Err(AppError::Conflict(
            "agent is already claimed by another user".into(),
        ))
    } else {
        Err(AppError::NotFound("agent not found".into()))
    }
}

pub async fn list_my_agents(
    auth: UserAuth,
    State(state): State<AppState>,
) -> Result<Json<AgentListResponse>, AppError> {
    let agents = sqlx::query_as::<_, AgentView>(
        "SELECT a.id, a.slug, a.display_name, a.framework, a.description, a.capabilities,
                a.owner_user_id, u.username AS owner_username,
                (a.revoked_at IS NOT NULL) AS is_revoked, a.created_at
         FROM agents a
         LEFT JOIN users u ON u.id = a.owner_user_id
         WHERE a.owner_user_id = $1
         ORDER BY a.created_at ASC, a.id ASC",
    )
    .bind(auth.user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(AgentListResponse { agents }))
}

pub async fn update_agent_profile(
    gov: GovernanceAuth,
    State(state): State<AppState>,
    Path(agent_id): Path<Uuid>,
    AppJson(req): AppJson<UpdateAgentRequest>,
) -> Result<Json<AgentEnvelope>, AppError> {
    ensure_can_manage_agent(&state, &gov, agent_id).await?;
    update_agent_profile_internal(&state, agent_id, req).await
}

pub async fn update_me(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
    AppJson(req): AppJson<UpdateAgentRequest>,
) -> Result<Json<AgentEnvelope>, AppError> {
    update_agent_profile_internal(&state, principal.id, req).await
}

pub async fn rotate_agent_token(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(agent_id): Path<Uuid>,
) -> Result<Json<IssuedAgentResponse>, AppError> {
    rotate_agent_token_internal(&state, agent_id).await
}

pub async fn rotate_my_agent_token(
    auth: UserAuth,
    State(state): State<AppState>,
    Path(agent_id): Path<Uuid>,
) -> Result<Json<IssuedAgentResponse>, AppError> {
    ensure_can_manage_agent(&state, &GovernanceAuth::User(auth.user), agent_id).await?;
    rotate_agent_token_internal(&state, agent_id).await
}

pub async fn rotate_me_token(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
) -> Result<Json<IssuedAgentResponse>, AppError> {
    rotate_agent_token_internal(&state, principal.id).await
}

pub async fn revoke_agent(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(agent_id): Path<Uuid>,
) -> Result<Json<AgentEnvelope>, AppError> {
    revoke_agent_internal(&state, agent_id).await
}

pub async fn revoke_my_agent(
    auth: UserAuth,
    State(state): State<AppState>,
    Path(agent_id): Path<Uuid>,
) -> Result<Json<AgentEnvelope>, AppError> {
    ensure_can_manage_agent(&state, &GovernanceAuth::User(auth.user), agent_id).await?;
    revoke_agent_internal(&state, agent_id).await
}

pub async fn revoke_me(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
) -> Result<Json<AgentEnvelope>, AppError> {
    revoke_agent_internal(&state, principal.id).await
}

pub async fn list_agents(
    State(state): State<AppState>,
) -> Result<Json<AgentListResponse>, AppError> {
    let agents = sqlx::query_as::<_, AgentView>(
        "SELECT a.id, a.slug, a.display_name, a.framework, a.description, a.capabilities,
                a.owner_user_id, u.username AS owner_username,
                (a.revoked_at IS NOT NULL) AS is_revoked, a.created_at
         FROM agents a
         LEFT JOIN users u ON u.id = a.owner_user_id
         ORDER BY a.created_at ASC, a.id ASC",
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(AgentListResponse { agents }))
}

pub async fn search_agents(
    State(state): State<AppState>,
    AppQuery(query): AppQuery<SearchAgentsQuery>,
) -> Result<Json<AgentSearchResponse>, AppError> {
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_keyset_cursor)
        .transpose()?;
    let mut statement = QueryBuilder::<Postgres>::new(PROFILE_SELECT);
    statement.push(" WHERE a.revoked_at IS NULL");
    if let Some(text) = query.q {
        let pattern = literal_search_pattern(text.as_str());
        statement
            .push(" AND (a.slug ILIKE ")
            .push_bind(pattern.clone())
            .push(" OR a.display_name ILIKE ")
            .push_bind(pattern)
            .push(")");
    }
    if let Some(framework) = &query.framework {
        statement
            .push(" AND a.framework = ")
            .push_bind(framework.as_str());
    }
    if let Some(capability) = &query.capability {
        statement
            .push(" AND ")
            .push_bind(capability.as_str().to_ascii_lowercase())
            .push(" = ANY(a.capabilities)");
    }
    if let Some((timestamp, id)) = cursor {
        statement
            .push(" AND (a.created_at, a.id) < (")
            .push_bind(timestamp)
            .push(", ")
            .push_bind(id)
            .push(")");
    }
    let limit = query.limit.get();
    statement
        .push(" ORDER BY a.created_at DESC, a.id DESC LIMIT ")
        .push_bind(limit + 1);
    let mut agents = statement
        .build_query_as::<AgentView>()
        .fetch_all(&state.db)
        .await?;
    let has_more = agents.len() as i64 > limit;
    let next_cursor = if has_more {
        agents.pop();
        agents
            .last()
            .map(|agent| encode_keyset_cursor(agent.created_at, agent.id))
    } else {
        None
    };
    Ok(Json(AgentSearchResponse {
        agents,
        next_cursor,
        has_more,
    }))
}

pub async fn get_agent_profile(
    State(state): State<AppState>,
    Path(agent_id): Path<Uuid>,
) -> Result<Json<AgentEnvelope>, AppError> {
    let mut statement = QueryBuilder::new(PROFILE_SELECT);
    statement.push(" WHERE a.id = ").push_bind(agent_id);
    fetch_profile(&state, statement).await
}

pub async fn get_agent_by_slug(
    State(state): State<AppState>,
    Path(slug): Path<Slug>,
) -> Result<Json<AgentEnvelope>, AppError> {
    let mut statement = QueryBuilder::new(PROFILE_SELECT);
    statement.push(" WHERE a.slug = ").push_bind(slug.as_str());
    fetch_profile(&state, statement).await
}

async fn fetch_profile(
    state: &AppState,
    mut statement: QueryBuilder<'_, Postgres>,
) -> Result<Json<AgentEnvelope>, AppError> {
    let agent = statement
        .build_query_as::<AgentView>()
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("agent not found".into()))?;
    Ok(Json(AgentEnvelope { agent }))
}

pub async fn get_me(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
) -> Result<Json<AgentEnvelope>, AppError> {
    let agent = sqlx::query_as::<_, AgentView>(
        "SELECT a.id, a.slug, a.display_name, a.framework, a.description, a.capabilities,
                a.owner_user_id, u.username AS owner_username,
                (a.revoked_at IS NOT NULL) AS is_revoked, a.created_at
         FROM agents a
         LEFT JOIN users u ON u.id = a.owner_user_id
         WHERE a.id = $1",
    )
    .bind(principal.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Unauthorized("agent no longer exists".into()))?;

    Ok(Json(AgentEnvelope { agent }))
}

async fn create_agent_record(
    state: &AppState,
    req: RegisterAgentRequest,
    owner_user_id: Option<Uuid>,
) -> Result<(StatusCode, Json<IssuedAgentResponse>), AppError> {
    let id = Uuid::new_v4();
    let (token, token_hash) = generate_agent_token();

    let agent = sqlx::query_as::<_, AgentView>(
        "WITH inserted AS (
             INSERT INTO agents (id, slug, display_name, framework, description, capabilities, owner_user_id, token_sha256)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, slug, display_name, framework, description, capabilities,
                       owner_user_id, revoked_at, created_at
         )
         SELECT ins.id, ins.slug, ins.display_name, ins.framework, ins.description, ins.capabilities,
                ins.owner_user_id, u.username AS owner_username,
                (ins.revoked_at IS NOT NULL) AS is_revoked, ins.created_at
         FROM inserted ins
         LEFT JOIN users u ON u.id = ins.owner_user_id",
    )
    .bind(id)
    .bind(req.slug.as_str())
    .bind(req.display_name.as_str())
    .bind(req.framework.as_str())
    .bind(req.description.as_str())
    .bind(req.capabilities.as_slice())
    .bind(owner_user_id)
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

    Ok((
        StatusCode::CREATED,
        Json(IssuedAgentResponse { agent, token }),
    ))
}

async fn update_agent_profile_internal(
    state: &AppState,
    agent_id: Uuid,
    req: UpdateAgentRequest,
) -> Result<Json<AgentEnvelope>, AppError> {
    let display_name = req.display_name.as_ref().map(|v| v.as_str());
    let description = req.description.as_ref().map(|v| v.as_str());
    let capabilities = req.capabilities.as_ref().map(|v| v.as_slice());

    let agent = sqlx::query_as::<_, AgentView>(
        "WITH updated AS (
             UPDATE agents
             SET display_name = COALESCE($2, display_name),
                 description = COALESCE($3, description),
                 capabilities = COALESCE($4, capabilities)
             WHERE id = $1
             RETURNING id, slug, display_name, framework, description, capabilities,
                       owner_user_id, revoked_at, created_at
         )
         SELECT up.id, up.slug, up.display_name, up.framework, up.description, up.capabilities,
                up.owner_user_id, u.username AS owner_username,
                (up.revoked_at IS NOT NULL) AS is_revoked, up.created_at
         FROM updated up
         LEFT JOIN users u ON u.id = up.owner_user_id",
    )
    .bind(agent_id)
    .bind(display_name)
    .bind(description)
    .bind(capabilities)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    state.auth_cache.refresh_agent_principal(AgentPrincipal {
        id: agent.id,
        slug: agent.slug.clone(),
        display_name: agent.display_name.clone(),
        framework: agent.framework.clone(),
    });

    Ok(Json(AgentEnvelope { agent }))
}

async fn rotate_agent_token_internal(
    state: &AppState,
    agent_id: Uuid,
) -> Result<Json<IssuedAgentResponse>, AppError> {
    let (token, token_hash) = generate_agent_token();

    let agent = sqlx::query_as::<_, AgentView>(
        "WITH updated AS (
             UPDATE agents
             SET token_sha256 = $2, revoked_at = NULL
             WHERE id = $1
             RETURNING id, slug, display_name, framework, description, capabilities,
                       owner_user_id, revoked_at, created_at
         )
         SELECT up.id, up.slug, up.display_name, up.framework, up.description, up.capabilities,
                up.owner_user_id, u.username AS owner_username,
                (up.revoked_at IS NOT NULL) AS is_revoked, up.created_at
         FROM updated up
         LEFT JOIN users u ON u.id = up.owner_user_id",
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

async fn revoke_agent_internal(
    state: &AppState,
    agent_id: Uuid,
) -> Result<Json<AgentEnvelope>, AppError> {
    let agent = sqlx::query_as::<_, AgentView>(
        "WITH updated AS (
             UPDATE agents
             SET token_sha256 = NULL, revoked_at = COALESCE(revoked_at, NOW())
             WHERE id = $1
             RETURNING id, slug, display_name, framework, description, capabilities,
                       owner_user_id, revoked_at, created_at
         )
         SELECT up.id, up.slug, up.display_name, up.framework, up.description, up.capabilities,
                up.owner_user_id, u.username AS owner_username,
                (up.revoked_at IS NOT NULL) AS is_revoked, up.created_at
         FROM updated up
         LEFT JOIN users u ON u.id = up.owner_user_id",
    )
    .bind(agent_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    state.auth_cache.revoke(agent_id);
    state.events.send_agent(agent_id, AgentSignal::Revoke);

    Ok(Json(AgentEnvelope { agent }))
}

async fn ensure_can_manage_agent(
    state: &AppState,
    gov: &GovernanceAuth,
    agent_id: Uuid,
) -> Result<(), AppError> {
    let owner_row: Option<(Option<Uuid>,)> =
        sqlx::query_as("SELECT owner_user_id FROM agents WHERE id = $1")
            .bind(agent_id)
            .fetch_optional(&state.db)
            .await?;

    let (owner_user_id,) = owner_row.ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    match gov {
        GovernanceAuth::Admin => Ok(()),
        GovernanceAuth::User(user) => {
            if owner_user_id == Some(user.id) {
                Ok(())
            } else {
                Err(AppError::Forbidden(
                    "only the owning user or admin can manage this agent".into(),
                ))
            }
        }
    }
}

fn map_unique_slug_conflict(err: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &err {
        if db_err.code().as_deref() == Some("23505") {
            return AppError::Conflict("agent slug already exists".into());
        }
    }
    AppError::from(err)
}
