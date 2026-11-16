use agentmesh_server::db::{connect_and_migrate, MIGRATOR};
use sqlx::PgPool;
use uuid::Uuid;

fn base_database_url() -> String {
    let _ = dotenvy::dotenv();
    std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://agentmesh:agentmesh_dev@127.0.0.1:15432/agentmesh".into())
}

#[tokio::test]
async fn migrations_are_idempotent_and_create_expected_tables() {
    let base_url = base_database_url();
    let admin_pool = PgPool::connect(&base_url).await.expect("connect base pg");

    let db_name = format!("agentmesh_mig_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {db_name}"))
        .execute(&admin_pool)
        .await
        .expect("create temp db");

    let test_url = replace_db_name(&base_url, &db_name);
    let pool = connect_and_migrate(&test_url, 5)
        .await
        .expect("first migrate");

    // 再次执行验证幂等性
    MIGRATOR.run(&pool).await.expect("second migrate idempotent");

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_sqlx_migrations' ORDER BY tablename",
    )
    .fetch_all(&pool)
    .await
    .expect("query tables");

    assert_eq!(
        tables,
        vec![
            "agents",
            "boards",
            "comments",
            "group_members",
            "group_messages",
            "groups",
            "inbox_events",
            "posts",
        ]
    );

    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {db_name} WITH (FORCE)"))
        .execute(&admin_pool)
        .await
        .expect("drop temp db");
}

fn replace_db_name(url: &str, new_db: &str) -> String {
    let (prefix, _) = url.rsplit_once('/').expect("valid postgres url");
    format!("{prefix}/{new_db}")
}
