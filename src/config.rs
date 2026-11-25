use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub db_max_connections: u32,
    pub admin_token: String,
    pub broadcast_capacity: usize,
    pub max_body_bytes: usize,
    pub max_private_groups_per_owner: i64,
    pub login_max_attempts: u32,
    pub login_rate_limit_window_secs: u64,
    pub session_ttl_secs: u64,
    pub inbox_retention_days: u64,
    pub web_dist_dir: PathBuf,
    pub docs_dist_dir: Option<PathBuf>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let bind_addr = env_or("BIND_ADDR", "0.0.0.0:18890")
            .parse::<SocketAddr>()
            .map_err(|e| format!("invalid BIND_ADDR: {e}"))?;

        let database_url = required_non_empty("DATABASE_URL")?;
        let admin_token = required_non_empty("ADMIN_TOKEN")?;

        let db_max_connections = parse_positive_u32("DB_MAX_CONNECTIONS", 50)?;
        let broadcast_capacity = parse_positive_usize("BROADCAST_CAPACITY", 1024)?;
        let max_body_bytes = parse_positive_usize("MAX_BODY_BYTES", 256 * 1024)?;
        let max_private_groups_per_owner =
            parse_positive_usize("MAX_PRIVATE_GROUPS_PER_OWNER", 3)? as i64;
        let login_max_attempts = parse_positive_u32("LOGIN_MAX_ATTEMPTS", 5)?;
        let login_rate_limit_window_secs =
            parse_positive_usize("LOGIN_RATE_LIMIT_WINDOW_SECS", 15 * 60)? as u64;
        let session_ttl_secs = parse_positive_usize("SESSION_TTL_SECS", 30 * 24 * 60 * 60)? as u64;
        let inbox_retention_days = parse_positive_usize("INBOX_RETENTION_DAYS", 90)? as u64;
        let web_dist_dir = PathBuf::from(env_or("WEB_DIST_DIR", "web/dist"));
        // Starlight 文档站产物目录；未设置时尝试 docs-site/dist，显式置空则关闭 /docs 托管。
        let docs_dist_dir = match env::var("DOCS_DIST_DIR") {
            Ok(value) if value.trim().is_empty() => None,
            Ok(value) => Some(PathBuf::from(value.trim())),
            Err(_) => Some(PathBuf::from("docs-site/dist")),
        };

        Ok(Self {
            bind_addr,
            database_url,
            db_max_connections,
            admin_token,
            broadcast_capacity,
            max_body_bytes,
            max_private_groups_per_owner,
            login_max_attempts,
            login_rate_limit_window_secs,
            session_ttl_secs,
            inbox_retention_days,
            web_dist_dir,
            docs_dist_dir,
        })
    }
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_owned())
}

fn required_non_empty(key: &str) -> Result<String, String> {
    let val = env::var(key).map_err(|_| format!("missing required env var {key}"))?;
    let trimmed = val.trim();
    if trimmed.is_empty() {
        return Err(format!("env var {key} must not be empty"));
    }
    Ok(trimmed.to_owned())
}

fn parse_positive_u32(key: &str, default: u32) -> Result<u32, String> {
    match env::var(key) {
        Ok(raw) => {
            let v = raw
                .parse::<u32>()
                .map_err(|e| format!("invalid {key}: {e}"))?;
            if v == 0 {
                return Err(format!("{key} must be > 0"));
            }
            Ok(v)
        }
        Err(_) => Ok(default),
    }
}

fn parse_positive_usize(key: &str, default: usize) -> Result<usize, String> {
    match env::var(key) {
        Ok(raw) => {
            let v = raw
                .parse::<usize>()
                .map_err(|e| format!("invalid {key}: {e}"))?;
            if v == 0 {
                return Err(format!("{key} must be > 0"));
            }
            Ok(v)
        }
        Err(_) => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    fn set_env(key: &str, value: Option<&str>) {
        match value {
            Some(value) => env::set_var(key, value),
            None => env::remove_var(key),
        }
    }

    #[test]
    fn config_parses_required_values_and_documented_defaults() {
        let _guard = env_lock();
        for (key, value) in [
            ("BIND_ADDR", Some("127.0.0.1:18890")),
            ("DATABASE_URL", Some("postgres://localhost/test")),
            ("ADMIN_TOKEN", Some("test-admin")),
            ("DB_MAX_CONNECTIONS", Some("7")),
            ("BROADCAST_CAPACITY", Some("11")),
            ("MAX_BODY_BYTES", Some("2048")),
            ("MAX_PRIVATE_GROUPS_PER_OWNER", Some("4")),
            ("LOGIN_MAX_ATTEMPTS", Some("3")),
            ("LOGIN_RATE_LIMIT_WINDOW_SECS", Some("60")),
            ("SESSION_TTL_SECS", Some("3600")),
            ("INBOX_RETENTION_DAYS", Some("30")),
            ("WEB_DIST_DIR", Some("custom-web")),
            ("DOCS_DIST_DIR", Some("custom-docs")),
        ] {
            set_env(key, value);
        }

        let config = Config::from_env().unwrap();
        assert_eq!(config.bind_addr.to_string(), "127.0.0.1:18890");
        assert_eq!(config.database_url, "postgres://localhost/test");
        assert_eq!(config.admin_token, "test-admin");
        assert_eq!(config.db_max_connections, 7);
        assert_eq!(config.broadcast_capacity, 11);
        assert_eq!(config.max_body_bytes, 2048);
        assert_eq!(config.max_private_groups_per_owner, 4);
        assert_eq!(config.login_max_attempts, 3);
        assert_eq!(config.login_rate_limit_window_secs, 60);
        assert_eq!(config.session_ttl_secs, 3600);
        assert_eq!(config.inbox_retention_days, 30);
        assert_eq!(config.web_dist_dir, PathBuf::from("custom-web"));
        assert_eq!(config.docs_dist_dir, Some(PathBuf::from("custom-docs")));
    }

    #[test]
    fn config_defaults_optional_values_and_can_disable_docs() {
        let _guard = env_lock();
        set_env("BIND_ADDR", None);
        set_env("DATABASE_URL", Some(" postgres://localhost/default "));
        set_env("ADMIN_TOKEN", Some(" admin "));
        set_env("DB_MAX_CONNECTIONS", None);
        set_env("BROADCAST_CAPACITY", None);
        set_env("MAX_BODY_BYTES", None);
        set_env("MAX_PRIVATE_GROUPS_PER_OWNER", None);
        set_env("LOGIN_MAX_ATTEMPTS", None);
        set_env("LOGIN_RATE_LIMIT_WINDOW_SECS", None);
        set_env("SESSION_TTL_SECS", None);
        set_env("INBOX_RETENTION_DAYS", None);
        set_env("WEB_DIST_DIR", None);
        set_env("DOCS_DIST_DIR", Some(""));

        let config = Config::from_env().unwrap();
        assert_eq!(config.bind_addr.to_string(), "0.0.0.0:18890");
        assert_eq!(config.database_url, "postgres://localhost/default");
        assert_eq!(config.admin_token, "admin");
        assert_eq!(config.db_max_connections, 50);
        assert_eq!(config.broadcast_capacity, 1024);
        assert_eq!(config.max_body_bytes, 256 * 1024);
        assert_eq!(config.max_private_groups_per_owner, 3);
        assert_eq!(config.login_max_attempts, 5);
        assert_eq!(config.login_rate_limit_window_secs, 15 * 60);
        assert_eq!(config.session_ttl_secs, 30 * 24 * 60 * 60);
        assert_eq!(config.inbox_retention_days, 90);
        assert_eq!(config.web_dist_dir, PathBuf::from("web/dist"));
        assert_eq!(config.docs_dist_dir, None);
    }

    #[test]
    fn config_rejects_invalid_required_and_positive_values() {
        let _guard = env_lock();
        set_env("DATABASE_URL", None);
        set_env("ADMIN_TOKEN", None);
        set_env("BIND_ADDR", None);
        assert!(Config::from_env().unwrap_err().contains("DATABASE_URL"));

        set_env("DATABASE_URL", Some("postgres://localhost/test"));
        set_env("ADMIN_TOKEN", Some("  "));
        assert!(Config::from_env().unwrap_err().contains("ADMIN_TOKEN"));

        set_env("ADMIN_TOKEN", Some("admin"));
        set_env("BIND_ADDR", Some("not-a-socket"));
        assert!(Config::from_env().unwrap_err().contains("BIND_ADDR"));

        set_env("BIND_ADDR", Some("127.0.0.1:18890"));
        set_env("DB_MAX_CONNECTIONS", Some("0"));
        assert!(Config::from_env()
            .unwrap_err()
            .contains("DB_MAX_CONNECTIONS"));

        set_env("DB_MAX_CONNECTIONS", Some("7"));
        set_env("INBOX_RETENTION_DAYS", Some("zero"));
        assert!(Config::from_env()
            .unwrap_err()
            .contains("INBOX_RETENTION_DAYS"));
    }
}
