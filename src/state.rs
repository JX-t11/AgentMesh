use std::path::PathBuf;
use std::sync::Arc;

use chrono::Duration as ChronoDuration;
use sqlx::PgPool;

use crate::auth::{hash_token, AuthCache, LoginRateLimiter};
use crate::events::EventHub;
use crate::observability::Metrics;

pub const DEFAULT_MAX_PRIVATE_GROUPS_PER_OWNER: i64 = 3;
pub const DEFAULT_LOGIN_MAX_ATTEMPTS: u32 = 5;
pub const DEFAULT_LOGIN_RATE_WINDOW_SECS: u64 = 15 * 60;
pub const DEFAULT_SESSION_TTL_SECS: u64 = 30 * 24 * 60 * 60;
pub const DEFAULT_INBOX_RETENTION_DAYS: u64 = 90;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub auth_cache: Arc<AuthCache>,
    pub login_rate_limiter: Arc<LoginRateLimiter>,
    pub events: Arc<EventHub>,
    pub metrics: Metrics,
    pub admin_token_sha256: [u8; 32],
    pub max_body_bytes: usize,
    pub max_private_groups_per_owner: i64,
    pub login_max_attempts: u32,
    pub login_rate_window: ChronoDuration,
    pub session_ttl: ChronoDuration,
    pub inbox_retention: ChronoDuration,
    pub web_dist_dir: Option<PathBuf>,
    pub docs_dist_dir: Option<PathBuf>,
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
            login_rate_limiter: Arc::new(LoginRateLimiter::default()),
            events: Arc::new(EventHub::new(broadcast_capacity)),
            metrics: Metrics::default(),
            admin_token_sha256: hash_token(admin_token),
            max_body_bytes,
            max_private_groups_per_owner: DEFAULT_MAX_PRIVATE_GROUPS_PER_OWNER,
            login_max_attempts: DEFAULT_LOGIN_MAX_ATTEMPTS,
            login_rate_window: ChronoDuration::seconds(
                DEFAULT_LOGIN_RATE_WINDOW_SECS
                    .try_into()
                    .unwrap_or(i64::MAX),
            ),
            session_ttl: ChronoDuration::seconds(
                DEFAULT_SESSION_TTL_SECS.try_into().unwrap_or(i64::MAX),
            ),
            inbox_retention: ChronoDuration::seconds(
                (DEFAULT_INBOX_RETENTION_DAYS * 24 * 60 * 60)
                    .try_into()
                    .unwrap_or(i64::MAX),
            ),
            web_dist_dir: None,
            docs_dist_dir: None,
        })
    }

    pub fn with_login_rate_limit(mut self, max_attempts: u32, window_secs: u64) -> Self {
        self.login_max_attempts = max_attempts;
        self.login_rate_window =
            ChronoDuration::seconds(window_secs.try_into().unwrap_or(i64::MAX));
        self
    }

    pub fn with_session_ttl_secs(mut self, ttl_secs: u64) -> Self {
        self.session_ttl = ChronoDuration::seconds(ttl_secs.try_into().unwrap_or(i64::MAX));
        self
    }

    pub fn with_inbox_retention_days(mut self, days: u64) -> Self {
        self.inbox_retention = ChronoDuration::seconds(
            (days.saturating_mul(24 * 60 * 60))
                .try_into()
                .unwrap_or(i64::MAX),
        );
        self
    }

    pub async fn cleanup_expired_user_sessions(&self) -> Result<u64, sqlx::Error> {
        let result = sqlx::query("DELETE FROM user_sessions WHERE expires_at <= NOW()")
            .execute(&self.db)
            .await?;
        Ok(result.rows_affected())
    }

    pub async fn cleanup_expired_inbox_events(&self) -> Result<u64, sqlx::Error> {
        let cutoff = chrono::Utc::now() - self.inbox_retention;
        let result = sqlx::query(
            "DELETE FROM inbox_events ie
             USING agents a
             WHERE ie.recipient_agent_id = a.id
               AND ie.inbox_seq <= a.acked_inbox_seq
               AND ie.created_at < $1",
        )
        .bind(cutoff)
        .execute(&self.db)
        .await?;
        Ok(result.rows_affected())
    }

    pub fn with_max_private_groups_per_owner(mut self, max: i64) -> Self {
        self.max_private_groups_per_owner = max;
        self
    }

    pub fn with_docs_dist_dir(mut self, dir: impl Into<Option<PathBuf>>) -> Self {
        self.docs_dist_dir = dir.into();
        self
    }

    pub fn with_web_dist_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.web_dist_dir = Some(dir.into());
        self
    }
}
