use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use dashmap::DashMap;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;

const PASSWORD_HASH_ROUNDS: u32 = 10_000;

#[derive(Debug, Clone)]
pub struct AgentPrincipal {
    pub id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub framework: String,
}

#[derive(Debug, Clone)]
pub struct UserPrincipal {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
}

#[derive(Default)]
pub struct AuthCache {
    by_hash: DashMap<[u8; 32], Arc<AgentPrincipal>>,
    hash_by_agent: DashMap<Uuid, [u8; 32]>,
    users_by_hash: DashMap<[u8; 32], Arc<UserPrincipal>>,
}

impl AuthCache {
    pub async fn load_from_db(pool: &PgPool) -> Result<Self, sqlx::Error> {
        let agent_rows: Vec<(Uuid, String, String, String, Vec<u8>)> = sqlx::query_as(
            "SELECT id, slug, display_name, framework, token_sha256
             FROM agents
             WHERE revoked_at IS NULL AND token_sha256 IS NOT NULL",
        )
        .fetch_all(pool)
        .await?;

        let user_rows: Vec<(Vec<u8>, Uuid, String, String)> = sqlx::query_as(
            "SELECT s.token_sha256, u.id, u.username, u.display_name
             FROM user_sessions s
             JOIN users u ON u.id = s.user_id",
        )
        .fetch_all(pool)
        .await?;

        let cache = Self::default();
        for (id, slug, display_name, framework, hash_bytes) in agent_rows {
            if let Ok(hash) = <[u8; 32]>::try_from(hash_bytes.as_slice()) {
                cache.upsert(
                    hash,
                    AgentPrincipal {
                        id,
                        slug,
                        display_name,
                        framework,
                    },
                );
            }
        }
        for (hash_bytes, id, username, display_name) in user_rows {
            if let Ok(hash) = <[u8; 32]>::try_from(hash_bytes.as_slice()) {
                cache.upsert_user_session(
                    hash,
                    UserPrincipal {
                        id,
                        username,
                        display_name,
                    },
                );
            }
        }
        Ok(cache)
    }

    pub fn verify_token(&self, raw_token: &str) -> Option<Arc<AgentPrincipal>> {
        let hash = hash_token(raw_token);
        self.by_hash
            .get(&hash)
            .map(|entry| Arc::clone(entry.value()))
    }

    pub fn verify_user_token(&self, raw_token: &str) -> Option<([u8; 32], Arc<UserPrincipal>)> {
        let hash = hash_token(raw_token);
        self.users_by_hash
            .get(&hash)
            .map(|entry| (hash, Arc::clone(entry.value())))
    }

    pub fn upsert(&self, token_hash: [u8; 32], principal: AgentPrincipal) {
        let agent_id = principal.id;
        if let Some((_, old_hash)) = self.hash_by_agent.remove(&agent_id) {
            self.by_hash.remove(&old_hash);
        }
        self.by_hash.insert(token_hash, Arc::new(principal));
        self.hash_by_agent.insert(agent_id, token_hash);
    }

    pub fn revoke(&self, agent_id: Uuid) {
        if let Some((_, old_hash)) = self.hash_by_agent.remove(&agent_id) {
            self.by_hash.remove(&old_hash);
        }
    }

    pub fn refresh_agent_principal(&self, principal: AgentPrincipal) {
        if let Some(hash_ref) = self.hash_by_agent.get(&principal.id) {
            let token_hash = *hash_ref.value();
            drop(hash_ref);
            self.by_hash.insert(token_hash, Arc::new(principal));
        }
    }

    pub fn upsert_user_session(&self, token_hash: [u8; 32], principal: UserPrincipal) {
        self.users_by_hash.insert(token_hash, Arc::new(principal));
    }

    pub fn remove_user_session(&self, token_hash: &[u8; 32]) {
        self.users_by_hash.remove(token_hash);
    }
}

pub fn generate_agent_token() -> (String, [u8; 32]) {
    generate_prefixed_token("amesh")
}

pub fn generate_user_token() -> (String, [u8; 32]) {
    generate_prefixed_token("umesh")
}

fn generate_prefixed_token(prefix: &str) -> (String, [u8; 32]) {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    let token = format!("{prefix}_{}", hex::encode(raw));
    let hash = hash_token(&token);
    (token, hash)
}

pub fn hash_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

pub fn hash_password(password: &str) -> ([u8; 32], [u8; 32]) {
    let mut salt = [0u8; 32];
    OsRng.fill_bytes(&mut salt);
    let digest = derive_password_hash(password, &salt);
    (salt, digest)
}

pub fn verify_password(password: &str, salt: &[u8], expected_hash: &[u8]) -> bool {
    if expected_hash.len() != 32 {
        return false;
    }
    let computed = derive_password_hash(password, salt);
    bool::from(computed.as_slice().ct_eq(expected_hash))
}

fn derive_password_hash(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut digest: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(salt);
        h.update(password.as_bytes());
        h.finalize().into()
    };
    for round in 1..PASSWORD_HASH_ROUNDS {
        let mut h = Sha256::new();
        h.update(salt);
        h.update(round.to_le_bytes());
        h.update(digest);
        digest = h.finalize().into();
    }
    digest
}

pub struct AdminAuth;

impl FromRequestParts<AppState> for AdminAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_bearer_header(parts)
            .ok_or_else(|| AppError::Unauthorized("missing bearer token".into()))?;

        if is_admin_token(token, state) {
            Ok(Self)
        } else {
            Err(AppError::Forbidden("invalid admin token".into()))
        }
    }
}

pub struct AgentAuth(pub Arc<AgentPrincipal>);

impl FromRequestParts<AppState> for AgentAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_bearer_or_ws_token(parts, &["/v1/ws/agent", "/api/v1/ws/agent"])
            .ok_or_else(|| AppError::Unauthorized("missing agent bearer token".into()))?;

        state
            .auth_cache
            .verify_token(token)
            .map(Self)
            .ok_or_else(|| AppError::Unauthorized("invalid or revoked agent token".into()))
    }
}

pub struct UserAuth {
    pub user: Arc<UserPrincipal>,
    pub token_hash: [u8; 32],
}

impl FromRequestParts<AppState> for UserAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_bearer_header(parts)
            .ok_or_else(|| AppError::Unauthorized("missing user session token".into()))?;

        let (token_hash, user) = state
            .auth_cache
            .verify_user_token(token)
            .ok_or_else(|| AppError::Unauthorized("invalid or expired user session".into()))?;

        Ok(Self { user, token_hash })
    }
}

#[derive(Debug, Clone)]
pub enum GovernanceAuth {
    Admin,
    User(Arc<UserPrincipal>),
}

impl FromRequestParts<AppState> for GovernanceAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_bearer_header(parts)
            .ok_or_else(|| AppError::Unauthorized("missing bearer token".into()))?;

        if is_admin_token(token, state) {
            return Ok(Self::Admin);
        }
        if let Some((_, user)) = state.auth_cache.verify_user_token(token) {
            return Ok(Self::User(user));
        }
        Err(AppError::Unauthorized("invalid user or admin token".into()))
    }
}

#[derive(Debug, Clone)]
pub enum AgentOrOwnerAuth {
    Admin,
    Agent(Arc<AgentPrincipal>),
    User(Arc<UserPrincipal>),
}

impl FromRequestParts<AppState> for AgentOrOwnerAuth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_bearer_header(parts)
            .ok_or_else(|| AppError::Unauthorized("missing bearer token".into()))?;

        if is_admin_token(token, state) {
            return Ok(Self::Admin);
        }
        if let Some((_, user)) = state.auth_cache.verify_user_token(token) {
            return Ok(Self::User(user));
        }
        if let Some(agent) = state.auth_cache.verify_token(token) {
            return Ok(Self::Agent(agent));
        }
        Err(AppError::Unauthorized("invalid bearer token".into()))
    }
}

#[derive(Debug, Clone)]
pub enum OptionalViewer {
    Anonymous,
    Admin,
    User(Arc<UserPrincipal>),
    Agent(Arc<AgentPrincipal>),
}

impl OptionalViewer {
    pub fn is_platform_authenticated(&self) -> bool {
        !matches!(self, Self::Anonymous)
    }
}

impl FromRequestParts<AppState> for OptionalViewer {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let Some(token) =
            extract_bearer_or_ws_token(parts, &["/v1/ws/observe", "/api/v1/ws/observe"])
        else {
            return Ok(Self::Anonymous);
        };

        if is_admin_token(token, state) {
            return Ok(Self::Admin);
        }
        if let Some((_, user)) = state.auth_cache.verify_user_token(token) {
            return Ok(Self::User(user));
        }
        if let Some(agent) = state.auth_cache.verify_token(token) {
            return Ok(Self::Agent(agent));
        }
        Err(AppError::Unauthorized(
            "invalid or expired bearer token".into(),
        ))
    }
}

fn is_admin_token(raw_token: &str, state: &AppState) -> bool {
    let provided_digest = hash_token(raw_token);
    bool::from(provided_digest.ct_eq(&state.admin_token_sha256))
}

fn extract_bearer_header(parts: &Parts) -> Option<&str> {
    let value = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn extract_bearer_or_ws_token<'a>(parts: &'a Parts, ws_paths: &[&str]) -> Option<&'a str> {
    if let Some(token) = extract_bearer_header(parts) {
        return Some(token);
    }
    if ws_paths.contains(&parts.uri.path()) {
        let query = parts.uri.query()?;
        for pair in query.split('&') {
            if let Some(val) = pair.strip_prefix("token=") {
                if !val.is_empty() {
                    return Some(val);
                }
            }
        }
    }
    None
}
