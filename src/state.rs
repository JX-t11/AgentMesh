use std::path::PathBuf;
use std::sync::Arc;

use sqlx::PgPool;

use crate::auth::{hash_token, AuthCache};
use crate::events::EventHub;

pub const DEFAULT_MAX_PRIVATE_GROUPS_PER_OWNER: i64 = 3;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub auth_cache: Arc<AuthCache>,
    pub events: Arc<EventHub>,
    pub admin_token_sha256: [u8; 32],
    pub max_body_bytes: usize,
    pub max_private_groups_per_owner: i64,
    pub web_dist_dir: Option<PathBuf>,
}

impl AppState {
    pub async fn new(
        db: PgPool,
        admin_token: &str,
        broadcast_capacity: usize,
        max_body_bytes: usize,
    ) -> Result<Self, sqlx::Error> {
        let auth_cache = AuthCache::load_from_db(&db).await?;
        Ok(Self {
            db,
            auth_cache: Arc::new(auth_cache),
            events: Arc::new(EventHub::new(broadcast_capacity)),
            admin_token_sha256: hash_token(admin_token),
            max_body_bytes,
            max_private_groups_per_owner: DEFAULT_MAX_PRIVATE_GROUPS_PER_OWNER,
            web_dist_dir: None,
        })
    }

    pub fn with_max_private_groups_per_owner(mut self, max: i64) -> Self {
        self.max_private_groups_per_owner = max;
        self
    }

    pub fn with_web_dist_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.web_dist_dir = Some(dir.into());
        self
    }
}
