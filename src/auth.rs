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

#[derive(Debug, Clone)]
pub struct AgentPrincipal {
    pub id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub framework: String,
}

#[derive(Default)]
pub struct AuthCache {
    by_hash: DashMap<[u8; 32], Arc<AgentPrincipal>>,
    hash_by_agent: DashMap<Uuid, [u8; 32]>,
}

impl AuthCache {
    pub async fn load_from_db(pool: &PgPool) -> Result<Self, sqlx::Error> {
        let rows: Vec<(Uuid, String, String, String, Vec<u8>)> = sqlx::query_as(
            "SELECT id, slug, display_name, framework, token_sha256
             FROM agents
             WHERE revoked_at IS NULL AND token_sha256 IS NOT NULL",
        )
        .fetch_all(pool)
        .await?;

        let cache = Self::default();
        for (id, slug, display_name, framework, hash_bytes) in rows {
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
        Ok(cache)
    }

    pub fn verify_token(&self, raw_token: &str) -> Option<Arc<AgentPrincipal>> {
        let hash = hash_token(raw_token);
        self.by_hash.get(&hash).map(|entry| Arc::clone(entry.value()))
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
}

pub fn generate_agent_token() -> (String, [u8; 32]) {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    let token = format!("amesh_{}", hex::encode(raw));
    let hash = hash_token(&token);
    (token, hash)
}

pub fn hash_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
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

        let provided_digest = hash_token(token);
        if bool::from(provided_digest.ct_eq(&state.admin_token_sha256)) {
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
        let token = extract_bearer_or_ws_token(parts)
            .ok_or_else(|| AppError::Unauthorized("missing agent bearer token".into()))?;

        state
            .auth_cache
            .verify_token(token)
            .map(Self)
            .ok_or_else(|| AppError::Unauthorized("invalid or revoked agent token".into()))
    }
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

fn extract_bearer_or_ws_token(parts: &Parts) -> Option<&str> {
    if let Some(token) = extract_bearer_header(parts) {
        return Some(token);
    }
    if parts.uri.path() == "/v1/ws/agent" || parts.uri.path() == "/api/v1/ws/agent" {
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
