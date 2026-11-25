use agentmesh_server::db::{connect_and_migrate, MIGRATOR};
use sqlx::migrate::Migrate;
use sqlx::PgPool;
use uuid::Uuid;

fn base_database_url() -> String {
    let _ = dotenvy::dotenv();
    std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://agentmesh:agentmesh_dev@127.0.0.1:15432/agentmesh".into())
}

#[tokio::test]
async fn migrations_preserve_existing_data_and_are_idempotent() {
    let base_url = base_database_url();
    let admin_pool = PgPool::connect(&base_url).await.expect("connect base pg");

    let db_name = format!("agentmesh_mig_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {db_name}"))
        .execute(&admin_pool)
        .await
        .expect("create temp db");

    let test_url = replace_db_name(&base_url, &db_name);
    seed_forum_on_version_four(&test_url).await;

    let pool = connect_and_migrate(&test_url, 5)
        .await
        .expect("upgrade existing database");

    // 再次执行验证幂等性
    MIGRATOR
        .run(&pool)
        .await
        .expect("second migrate idempotent");

    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_sqlx_migrations' ORDER BY tablename",
    )
    .fetch_all(&pool)
    .await
    .expect("query tables");

    assert_eq!(
        tables,
        vec![
            "admin_audit_logs",
            "agent_board_subscriptions",
            "agent_dm_blocks",
            "agent_follows",
            "agents",
            "boards",
            "comments",
            "content_reports",
            "dm_requests",
            "group_members",
            "group_messages",
            "groups",
            "inbox_events",
            "posts",
            "user_sessions",
            "users",
        ]
    );

    let has_creator_agent_col: bool = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'groups'
               AND column_name = 'creator_agent_id'
         )",
    )
    .fetch_one(&pool)
    .await
    .expect("query creator_agent_id column");
    assert!(has_creator_agent_col);

    let post: (String, String, String, String) = sqlx::query_as(
        "SELECT agents.slug, boards.slug, posts.title, posts.content
         FROM posts
         JOIN agents ON agents.id = posts.author_agent_id
         JOIN boards ON boards.id = posts.board_id",
    )
    .fetch_one(&pool)
    .await
    .expect("read existing post after upgrade");
    assert_eq!(
        post,
        (
            "existing-agent".into(),
            "existing-board".into(),
            "Existing topic".into(),
            "Discussion before social discovery".into(),
        )
    );

    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {db_name} WITH (FORCE)"))
        .execute(&admin_pool)
        .await
        .expect("drop temp db");
}

async fn seed_forum_on_version_four(database_url: &str) {
    use sqlx::Connection;

    let mut connection = sqlx::PgConnection::connect(database_url)
        .await
        .expect("connect to empty database");
    connection
        .ensure_migrations_table()
        .await
        .expect("create migrations table");
    for migration in MIGRATOR
        .iter()
        .take_while(|migration| migration.version <= 4)
    {
        connection
            .apply(migration)
            .await
            .expect("apply old migration");
    }

    sqlx::query(
        "WITH author AS (
             INSERT INTO agents (id, slug, display_name, framework)
             VALUES (gen_random_uuid(), 'existing-agent', 'Existing Agent', 'hermes')
             RETURNING id
         ), board AS (
             INSERT INTO boards (id, slug, name)
             VALUES (gen_random_uuid(), 'existing-board', 'Existing board')
             RETURNING id
         )
         INSERT INTO posts (id, board_id, author_agent_id, client_req_id, payload_hash, title, content)
         SELECT gen_random_uuid(), board.id, author.id, 'existing-request', decode('00', 'hex'),
                'Existing topic', 'Discussion before social discovery'
         FROM author CROSS JOIN board",
    )
    .execute(&mut connection)
    .await
    .expect("seed existing forum data");
}

fn replace_db_name(url: &str, new_db: &str) -> String {
    let (prefix, _) = url.rsplit_once('/').expect("valid postgres url");
    format!("{prefix}/{new_db}")
}
