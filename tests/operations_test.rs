mod common;

use common::{TestApp, TEST_ADMIN_TOKEN};
use futures_util::future::join_all;
use serde_json::{json, Value};
use uuid::Uuid;

async fn register_agent(app: &TestApp, slug: &str) -> (Uuid, String) {
    let body: Value = app
        .client
        .post(format!("{}/api/v1/agents/register", app.base_url))
        .json(&json!({"slug": slug, "display_name": slug, "framework": "openclaw"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = Uuid::parse_str(body["agent"]["id"].as_str().unwrap()).unwrap();
    (id, body["token"].as_str().unwrap().to_owned())
}

async fn create_board(app: &TestApp, slug: &str) -> Uuid {
    let body: Value = app
        .client
        .post(format!("{}/api/v1/admin/boards", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(&json!({"slug": slug, "name": slug, "visibility": "public"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    Uuid::parse_str(body["board"]["id"].as_str().unwrap()).unwrap()
}

async fn create_post(app: &TestApp, token: &str, board_id: Uuid, req: &str) -> Uuid {
    let body: Value = app
        .client
        .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
        .bearer_auth(token)
        .json(&json!({
            "client_req_id": req,
            "title": format!("operations post {req}"),
            "content": "operations fixture"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    Uuid::parse_str(body["post"]["id"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn active_pagination_does_not_skip_an_old_post_bumped_after_page_one() {
    let app = TestApp::spawn().await;
    let board_id = create_board(&app, "active-pagination").await;
    let (_, first_token) = register_agent(&app, "active-first").await;
    let (_, second_token) = register_agent(&app, "active-second").await;
    let (_, third_token) = register_agent(&app, "active-third").await;

    let first = create_post(&app, &first_token, board_id, "first").await;
    let second = create_post(&app, &second_token, board_id, "second").await;
    let third = create_post(&app, &third_token, board_id, "third").await;

    sqlx::query("UPDATE posts SET created_at = $2, last_activity_at = $2 WHERE id = $1")
        .bind(first)
        .bind(chrono::Utc::now() - chrono::Duration::hours(1))
        .execute(&app.db)
        .await
        .unwrap();
    sqlx::query("UPDATE posts SET created_at = $2, last_activity_at = $2 WHERE id = $1")
        .bind(second)
        .bind(chrono::Utc::now() - chrono::Duration::hours(2))
        .execute(&app.db)
        .await
        .unwrap();
    sqlx::query("UPDATE posts SET created_at = $2, last_activity_at = $2 WHERE id = $1")
        .bind(third)
        .bind(chrono::Utc::now() - chrono::Duration::hours(3))
        .execute(&app.db)
        .await
        .unwrap();

    let page: Value = app
        .client
        .get(format!("{}/api/v1/posts?sort=active&limit=2", app.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let cursor = page["next_cursor"].as_str().unwrap().to_owned();

    // An unseen, older-created post moves to the active top after page one was rendered.
    app.client
        .post(format!("{}/api/v1/posts/{third}/comments", app.base_url))
        .bearer_auth(&first_token)
        .json(&json!({"client_req_id": "bump-third", "content": "bump old post"}))
        .send()
        .await
        .unwrap();

    let second_page: Value = app
        .client
        .get(format!(
            "{}/api/v1/posts?sort=active&limit=2&cursor={cursor}",
            app.base_url
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let ids: Vec<String> = second_page["posts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|post| post["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(
        ids.contains(&third.to_string()),
        "bumped old post was skipped: {second_page}"
    );

    app.cleanup().await;
}

#[tokio::test]
async fn concurrent_comments_receive_stable_per_post_sequence_numbers() {
    let app = TestApp::spawn().await;
    let board_id = create_board(&app, "comment-sequence").await;
    let (_, author_token) = register_agent(&app, "sequence-author").await;
    let post_id = create_post(&app, &author_token, board_id, "sequence-root").await;

    let mut handles = Vec::new();
    for idx in 0..4 {
        let (_, token) = register_agent(&app, &format!("sequence-writer-{idx}")).await;
        let client = app.client.clone();
        let url = format!("{}/api/v1/posts/{post_id}/comments", app.base_url);
        let req_id = format!("sequence-comment-{idx}");
        let content = format!("sequence comment {idx}");
        handles.push(tokio::spawn(async move {
            client
                .post(url)
                .bearer_auth(token)
                .json(&json!({"client_req_id": req_id, "content": content}))
                .send()
                .await
                .unwrap()
        }));
    }

    let responses = join_all(handles).await;
    let mut seqs = Vec::new();
    for response in responses {
        let response = response.unwrap();
        assert_eq!(response.status(), 201);
        let body: Value = response.json().await.unwrap();
        seqs.push(body["comment"]["seq"].as_i64().unwrap());
    }
    seqs.sort();
    assert_eq!(seqs, vec![1, 2, 3, 4]);

    let page: Value = app
        .client
        .get(format!("{}/api/v1/posts/{post_id}/comments", app.base_url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let listed: Vec<i64> = page["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|comment| comment["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(listed, vec![1, 2, 3, 4]);

    app.cleanup().await;
}

#[tokio::test]
async fn directory_board_and_group_lists_are_bounded() {
    let app = TestApp::spawn().await;
    create_board(&app, "bounded-board-a").await;
    create_board(&app, "bounded-board-b").await;
    register_agent(&app, "bounded-agent-a").await;
    register_agent(&app, "bounded-agent-b").await;
    // Public groups are admin-created; one fixture is enough to verify the bound.
    app.client
        .post(format!("{}/api/v1/admin/groups", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(
            &json!({"slug": "bounded-group-a", "name": "Bounded Group A", "visibility": "public"}),
        )
        .send()
        .await
        .unwrap();
    app.client
        .post(format!("{}/api/v1/admin/groups", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .json(
            &json!({"slug": "bounded-group-b", "name": "Bounded Group B", "visibility": "public"}),
        )
        .send()
        .await
        .unwrap();

    for (path, array_key) in [
        ("/api/v1/boards", "boards"),
        ("/api/v1/groups", "groups"),
        ("/api/v1/agents", "agents"),
    ] {
        let page: Value = app
            .client
            .get(format!("{}{path}?limit=1", app.base_url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(page[array_key].as_array().unwrap().len(), 1, "{path}");
        assert_eq!(page["has_more"], true, "{path}");
        assert!(page["next_cursor"].is_string(), "{path}");

        let cursor = page["next_cursor"].as_str().unwrap();
        let next: Value = app
            .client
            .get(format!("{}{path}?limit=1&cursor={cursor}", app.base_url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(next[array_key].as_array().unwrap().len(), 1, "{path}");
        let first_ids: Vec<String> = page[array_key]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_owned())
            .collect();
        let next_ids: Vec<String> = next[array_key]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_owned())
            .collect();
        assert!(first_ids.iter().all(|id| !next_ids.contains(id)));
    }

    app.cleanup().await;
}

#[tokio::test]
async fn migration_installs_literal_search_indexes() {
    let app = TestApp::spawn().await;
    let index_names: Vec<String> = sqlx::query_scalar(
        "SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND indexname IN (
             'idx_posts_title_trgm', 'idx_posts_content_trgm',
             'idx_agents_slug_trgm', 'idx_agents_display_name_trgm'
         ) ORDER BY indexname",
    )
    .fetch_all(&app.db)
    .await
    .unwrap();
    assert_eq!(
        index_names,
        vec![
            "idx_agents_display_name_trgm",
            "idx_agents_slug_trgm",
            "idx_posts_content_trgm",
            "idx_posts_title_trgm",
        ]
    );
    app.cleanup().await;
}

#[tokio::test]
async fn inbox_retention_removes_old_acked_events_and_keeps_unacked_events() {
    let app = TestApp::spawn().await;
    let (_, token) = register_agent(&app, "inbox-retention-agent").await;
    let body: Value = app
        .client
        .get(format!("{}/api/v1/agents/me", app.base_url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let agent_id = Uuid::parse_str(body["agent"]["id"].as_str().unwrap()).unwrap();
    let old = chrono::Utc::now() - chrono::Duration::days(91);
    sqlx::query("UPDATE agents SET acked_inbox_seq = 1 WHERE id = $1")
        .bind(agent_id)
        .execute(&app.db)
        .await
        .unwrap();
    for seq in 1..=2 {
        sqlx::query(
            "INSERT INTO inbox_events
                 (recipient_agent_id, inbox_seq, kind, source_id, actor_agent_id, summary, created_at)
             VALUES ($1, $2, 'post_mention', $3, $1, 'retention fixture', $4)",
        )
        .bind(agent_id)
        .bind(seq)
        .bind(Uuid::new_v4())
        .bind(old)
        .execute(&app.db)
        .await
        .unwrap();
    }

    let deleted = app.state.cleanup_expired_inbox_events().await.unwrap();
    assert_eq!(deleted, 1);
    let remaining: Vec<i64> = sqlx::query_scalar(
        "SELECT inbox_seq FROM inbox_events WHERE recipient_agent_id = $1 ORDER BY inbox_seq",
    )
    .bind(agent_id)
    .fetch_all(&app.db)
    .await
    .unwrap();
    assert_eq!(remaining, vec![2]);

    app.cleanup().await;
}

#[tokio::test]
async fn http_responses_preserve_or_assign_request_ids() {
    let app = TestApp::spawn().await;
    let assigned = app
        .client
        .get(format!("{}/api/v1/health", app.base_url))
        .send()
        .await
        .unwrap();
    assert!(assigned
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(|value| Uuid::parse_str(value).is_ok())
        .unwrap_or(false));

    let provided = app
        .client
        .get(format!("{}/api/v1/health", app.base_url))
        .header("x-request-id", "11111111-1111-4111-8111-111111111111")
        .send()
        .await
        .unwrap();
    assert_eq!(
        provided
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok()),
        Some("11111111-1111-4111-8111-111111111111")
    );

    app.cleanup().await;
}

#[tokio::test]
async fn admin_can_scrape_http_metrics() {
    let app = TestApp::spawn().await;
    app.client
        .get(format!("{}/api/v1/health", app.base_url))
        .send()
        .await
        .unwrap();
    let metrics = app
        .client
        .get(format!("{}/api/v1/admin/metrics", app.base_url))
        .bearer_auth(TEST_ADMIN_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(metrics.status(), 200);
    let body = metrics.text().await.unwrap();
    assert!(body.contains("agentmesh_http_requests_total"));
    assert!(body.contains("route=\"/api/v1/health\""));
    assert!(body.contains("status=\"200\""));
    app.cleanup().await;
}
