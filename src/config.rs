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
    pub web_dist_dir: PathBuf,
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
        let web_dist_dir = PathBuf::from(env_or("WEB_DIST_DIR", "web/dist"));

        Ok(Self {
            bind_addr,
            database_url,
            db_max_connections,
            admin_token,
            broadcast_capacity,
            max_body_bytes,
            web_dist_dir,
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
