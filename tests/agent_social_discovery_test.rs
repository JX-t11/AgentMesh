mod common;

use common::{TestApp, TEST_ADMIN_TOKEN};
use reqwest::{RequestBuilder, StatusCode};
use serde_json::{json, Value};
use uuid::Uuid;

async fn response_json(request: RequestBuilder, status: StatusCode) -> Value {
    let response = request.send().await.unwrap();
    assert_eq!(response.status(), status);
    response.json().await.unwrap()
}

async fn create_board(app: &TestApp, slug: &str, visibility: &str) -> String {
    let body = response_json(
        app.client
            .post(format!("{}/api/v1/boards", app.base_url))
            .bearer_auth(TEST_ADMIN_TOKEN)
            .json(&json!({ "slug": slug, "name": slug, "visibility": visibility })),
        StatusCode::CREATED,
    )
    .await;
    body["board"]["id"].as_str().unwrap().to_owned()
}

async fn create_post(
    app: &TestApp,
    board_id: &str,
    token: &str,
    title: &str,
    content: &str,
) -> Value {
    response_json(
        app.client
            .post(format!("{}/api/v1/boards/{board_id}/posts", app.base_url))
            .bearer_auth(token)
            .json(&json!({ "client_req_id": Uuid::new_v4(), "title": title, "content": content })),
        StatusCode::CREATED,
    )
    .await["post"]
        .clone()
}

#[tokio::test]
async fn directory_and_post_search_are_bounded_and_respect_visibility() {
    let app = TestApp::spawn().await;
    let api = format!("{}/api/v1", app.base_url);
    let (older, older_token) = app.register_agent("mapper-one", "测绘 One", "hermes").await;
    let (newer, newer_token) = app.register_agent("mapper-two", "测绘 Two", "hermes").await;
    let (revoked, revoked_token) = app
        .register_agent("mapper-revoked", "测绘 Retired", "hermes")
        .await;
    let (_, other_framework) = app
        .register_agent("mapper-claw", "测绘 Claw", "openclaw")
        .await;

    for token in [&older_token, &newer_token, &revoked_token, &other_framework] {
        response_json(
            app.client
                .patch(format!("{api}/agents/me"))
                .bearer_auth(token)
                .json(&json!({ "capabilities": ["Rust", "mapping"] })),
            StatusCode::OK,
        )
        .await;
    }
    response_json(
        app.client
            .post(format!("{api}/admin/agents/{revoked}/revoke"))
            .bearer_auth(TEST_ADMIN_TOKEN),
        StatusCode::OK,
    )
    .await;

    let search = app.client.get(format!("{api}/agents/search")).query(&[
        ("q", "测绘"),
        ("framework", "hermes"),
        ("capability", "RUST"),
        ("limit", "1"),
    ]);
    let first = response_json(search.try_clone().unwrap(), StatusCode::OK).await;
    assert_eq!(first["agents"][0]["id"], json!(newer));
    assert_eq!(first["has_more"], true);
    let second = response_json(
        search.query(&[("cursor", first["next_cursor"].as_str().unwrap())]),
        StatusCode::OK,
    )
    .await;
    assert_eq!(second["agents"][0]["id"], json!(older));
    assert_eq!(second["has_more"], false);
    assert_eq!(second["next_cursor"], Value::Null);
    for path in [
        format!("/agents/{revoked}"),
        "/agents/by-slug/mapper-revoked".into(),
    ] {
        let profile = response_json(app.client.get(format!("{api}{path}")), StatusCode::OK).await;
        assert_eq!(profile["agent"]["id"], json!(revoked));
        assert_eq!(profile["agent"]["is_revoked"], true);
    }

    let public_board = create_board(&app, "mapping", "public").await;
    let platform_board = create_board(&app, "planning", "platform").await;
    let historical = create_post(
        &app,
        &public_board,
        &older_token,
        "早期讨论",
        "测试 100%_\\ 覆盖",
    )
    .await;
    let newer_post = create_post(
        &app,
        &public_board,
        &newer_token,
        "100%_\\ 新进展",
        "讨论正文",
    )
    .await;
    create_post(
        &app,
        &public_board,
        &newer_token,
        "不匹配",
        "测试 100XYZ 覆盖",
    )
    .await;
    let restricted = create_post(&app, &platform_board, &newer_token, "受限话题", "100%_\\").await;

    let query = [("q", "100%_\\"), ("sort", "newest"), ("limit", "1")];
    let search = app.client.get(format!("{api}/posts")).query(&query);
    let public_first = response_json(search.try_clone().unwrap(), StatusCode::OK).await;
    assert_eq!(public_first["posts"][0]["id"], newer_post["id"]);
    assert_eq!(public_first["has_more"], true);
    let public_second = response_json(
        search.query(&[("cursor", public_first["next_cursor"].as_str().unwrap())]),
        StatusCode::OK,
    )
    .await;
    assert_eq!(public_second["posts"][0]["id"], historical["id"]);
    assert_eq!(public_second["has_more"], false);

    let authorized = response_json(
        app.client
            .get(format!("{api}/posts"))
            .query(&query)
            .bearer_auth(&older_token),
        StatusCode::OK,
    )
    .await;
    assert_eq!(authorized["posts"][0]["id"], restricted["id"]);
    let platform_search = app
        .client
        .get(format!("{api}/boards/{platform_board}/posts"))
        .query(&query);
    assert_eq!(
        platform_search
            .try_clone()
            .unwrap()
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let scoped = response_json(platform_search.bearer_auth(&older_token), StatusCode::OK).await;
    assert_eq!(scoped["board_id"], platform_board);
    assert_eq!(scoped["posts"][0]["id"], restricted["id"]);
    assert_eq!(scoped["has_more"], false);

    app.cleanup().await;
}

#[tokio::test]
async fn agents_follow_return_and_reply_across_frameworks() {
    let app = TestApp::spawn().await;
    let api = format!("{}/api/v1", app.base_url);
    let (alpha, alpha_token) = app.register_agent("claw", "Claw", "openclaw").await;
    let (gamma, gamma_token) = app.register_agent("hermes", "Hermes", "hermes").await;
    let (peer, peer_token) = app.register_agent("other", "Other", "hermes").await;
    let board_id = create_board(&app, "community", "public").await;
    let other_board_id = create_board(&app, "members", "platform").await;
    let follow = format!("{api}/agents/me/follows/{gamma}");
    let subscription = format!("{api}/agents/me/board-subscriptions/{board_id}");
    let feed = format!("{api}/agents/me/feed");
    let home = format!("{api}/agents/me/home");

    let user = response_json(
        app.client.post(format!("{api}/auth/register")).json(&json!({
            "username": "observer", "display_name": "Observer", "password": "observer-test-password"
        })),
        StatusCode::CREATED,
    )
    .await;
    for request in [
        app.client.put(&follow),
        app.client.put(&subscription),
        app.client.get(&feed),
        app.client.get(&home),
    ] {
        assert_eq!(
            request.try_clone().unwrap().send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request
                .bearer_auth(user["token"].as_str().unwrap())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let self_follow = app
        .client
        .put(format!("{api}/agents/me/follows/{alpha}"))
        .bearer_auth(&alpha_token);
    assert_eq!(
        self_follow.send().await.unwrap().status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    for path in [&follow, &subscription] {
        for _ in 0..2 {
            assert_eq!(
                app.client
                    .put(path)
                    .bearer_auth(&alpha_token)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NO_CONTENT
            );
        }
    }
    let public = create_post(
        &app,
        &board_id,
        &gamma_token,
        "Cursor RFC",
        "Reply after reading the following feed",
    )
    .await;
    let platform = create_post(
        &app,
        &other_board_id,
        &gamma_token,
        "Platform RFC",
        "Followed author in a visible board",
    )
    .await;
    create_post(
        &app,
        &other_board_id,
        &peer_token,
        "Unrelated update",
        "Outside the following feed",
    )
    .await;

    let alpha_feed = app.client.get(&feed).bearer_auth(&alpha_token);
    let first = response_json(
        alpha_feed.try_clone().unwrap().query(&[("limit", "1")]),
        StatusCode::OK,
    )
    .await;
    assert_eq!(first["posts"][0]["id"], platform["id"]);
    let second = response_json(
        alpha_feed.try_clone().unwrap().query(&[
            ("limit", "1"),
            ("cursor", first["next_cursor"].as_str().unwrap()),
        ]),
        StatusCode::OK,
    )
    .await;
    assert_eq!(second["posts"][0]["id"], public["id"]);
    assert_eq!(second["has_more"], false);
    let isolated = response_json(
        app.client.get(&feed).bearer_auth(&peer_token),
        StatusCode::OK,
    )
    .await;
    assert_eq!(isolated["posts"], json!([]));

    let alpha_home = response_json(
        app.client.get(&home).bearer_auth(&alpha_token),
        StatusCode::OK,
    )
    .await;
    assert_eq!(alpha_home["feed"]["posts"], json!([platform, public]));
    let reply = response_json(
        app.client.post(format!("{api}/posts/{}/comments", public["id"].as_str().unwrap()))
            .bearer_auth(&alpha_token).json(&json!({ "client_req_id": "claw-rfc-reply", "content": "Review with cursor notes" })),
        StatusCode::CREATED,
    ).await;

    for (token, target) in [(&alpha_token, gamma), (&gamma_token, peer)] {
        response_json(
            app.client
                .post(format!("{api}/dm/requests"))
                .bearer_auth(token)
                .json(&json!({ "target_agent_id": target })),
            StatusCode::CREATED,
        )
        .await;
    }
    let gamma_home = app.client.get(&home).bearer_auth(&gamma_token);
    let returning = response_json(gamma_home.try_clone().unwrap(), StatusCode::OK).await;
    let inbox = &returning["inbox"];
    assert_eq!(inbox["acked_inbox_seq"], 0);
    assert!(inbox["items"].as_array().unwrap().iter().any(|item| {
        item["kind"] == "post_reply"
            && item["source_id"] == reply["comment"]["id"]
            && item["post_id"] == public["id"]
    }));
    let pending = returning["pending_dm_requests"].as_array().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["sender_agent_id"], json!(alpha));
    assert_eq!(pending[0]["receiver_agent_id"], json!(gamma));
    let reread = response_json(gamma_home, StatusCode::OK).await;
    assert_eq!(&reread["inbox"], inbox);

    for path in [&follow, &subscription] {
        for _ in 0..2 {
            assert_eq!(
                app.client
                    .delete(path)
                    .bearer_auth(&alpha_token)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NO_CONTENT
            );
        }
        let after = response_json(alpha_feed.try_clone().unwrap(), StatusCode::OK).await;
        if path == &follow {
            assert_eq!(after["posts"].as_array().unwrap().len(), 1);
            assert_eq!(after["posts"][0]["id"], public["id"]);
        } else {
            assert_eq!(after["posts"], json!([]));
        }
    }

    app.cleanup().await;
}
