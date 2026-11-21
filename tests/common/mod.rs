#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;

use agentmesh_server::db::connect_and_migrate;
use agentmesh_server::routes::build_router;
use agentmesh_server::state::AppState;
use reqwest::Client;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use uuid::Uuid;

pub const TEST_ADMIN_TOKEN: &str = "test_admin_secret_token_2026";

pub struct TestApp {
    pub addr: SocketAddr,
    pub base_url: String,
    pub ws_base_url: String,
    pub db: PgPool,
    pub state: AppState,
    pub client: Client,
    admin_pool: PgPool,
    db_name: String,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl TestApp {
    pub async fn spawn() -> Self {
        Self::spawn_with_capacity(1024).await
    }

    pub async fn spawn_with_capacity(broadcast_capacity: usize) -> Self {
        Self::spawn_full(broadcast_capacity, None, None).await
    }

    pub async fn spawn_with_web_dist(web_dist_dir: PathBuf) -> Self {
        Self::spawn_full(1024, Some(web_dist_dir), None).await
    }

    pub async fn spawn_with_web_and_docs_dist(
        web_dist_dir: PathBuf,
        docs_dist_dir: PathBuf,
    ) -> Self {
        Self::spawn_full(1024, Some(web_dist_dir), Some(docs_dist_dir)).await
    }

    async fn spawn_full(
        broadcast_capacity: usize,
        web_dist_dir: Option<PathBuf>,
        docs_dist_dir: Option<PathBuf>,
    ) -> Self {
        let _ = dotenvy::dotenv();
        let base_db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agentmesh:agentmesh_dev@127.0.0.1:15432/agentmesh".into()
        });

        let admin_pool = PgPool::connect(&base_db_url)
            .await
            .expect("connect admin pg");

        let db_name = format!("agentmesh_t_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {db_name}"))
            .execute(&admin_pool)
            .await
            .expect("create test database");

        let (prefix, _) = base_db_url.rsplit_once('/').expect("valid DATABASE_URL");
        let test_db_url = format!("{prefix}/{db_name}");

        let db = connect_and_migrate(&test_db_url, 32)
            .await
            .expect("connect and migrate test db");

        let mut state = AppState::new(db.clone(), TEST_ADMIN_TOKEN, broadcast_capacity, 256 * 1024)
            .await
            .expect("init app state");
        if let Some(dir) = web_dist_dir {
            state = state.with_web_dist_dir(dir);
        }
        if let Some(dir) = docs_dist_dir {
            state = state.with_docs_dist_dir(dir);
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let addr = listener.local_addr().unwrap();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let router = build_router(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Self {
            addr,
            base_url: format!("http://{addr}"),
            ws_base_url: format!("ws://{addr}"),
            db,
            state,
            client: Client::new(),
            admin_pool,
            db_name,
            shutdown_tx: Some(shutdown_tx),
        }
    }

    pub async fn register_agent(&self, slug: &str, name: &str, framework: &str) -> (Uuid, String) {
        let resp = self
            .client
            .post(format!("{}/api/v1/admin/agents", self.base_url))
            .bearer_auth(TEST_ADMIN_TOKEN)
            .json(&json!({
                "slug": slug,
                "display_name": name,
                "framework": framework,
            }))
            .send()
            .await
            .expect("register agent request");
        assert_eq!(resp.status(), 201);
        let body: Value = resp.json().await.unwrap();
        let id = Uuid::parse_str(body["agent"]["id"].as_str().unwrap()).unwrap();
        let token = body["token"].as_str().unwrap().to_owned();
        (id, token)
    }

    pub async fn cleanup(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.db.close().await;
        let _ = sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.db_name))
            .execute(&self.admin_pool)
            .await;
        self.admin_pool.close().await;
    }
}
