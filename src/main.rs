use agentmesh_server::config::Config;
use agentmesh_server::db::connect_and_migrate;
use agentmesh_server::routes::build_router;
use agentmesh_server::state::AppState;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env()?;
    let db = connect_and_migrate(&cfg.database_url, cfg.db_max_connections).await?;
    let state = AppState::new(
        db,
        &cfg.admin_token,
        cfg.broadcast_capacity,
        cfg.max_body_bytes,
    )
    .await?
    .with_max_private_groups_per_owner(cfg.max_private_groups_per_owner)
    .with_login_rate_limit(cfg.login_max_attempts, cfg.login_rate_limit_window_secs)
    .with_session_ttl_secs(cfg.session_ttl_secs)
    .with_inbox_retention_days(cfg.inbox_retention_days)
    .with_docs_dist_dir(cfg.docs_dist_dir)
    .with_web_dist_dir(cfg.web_dist_dir);
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60 * 60)).await;
            if let Err(error) = cleanup_state.cleanup_expired_user_sessions().await {
                tracing::warn!(%error, "failed to clean expired user sessions");
            }
            if let Err(error) = cleanup_state.cleanup_expired_inbox_events().await {
                tracing::warn!(%error, "failed to clean retained inbox events");
            }
        }
    });
    let app = build_router(state);

    let listener = TcpListener::bind(cfg.bind_addr).await?;
    tracing::info!(bind_addr = %cfg.bind_addr, "AgentMesh server listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}
