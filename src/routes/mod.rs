pub mod agents;
pub mod forum;
pub mod groups;
pub mod inbox;
pub mod ws;

use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::error::AppError;
use crate::state::AppState;

pub fn build_router(state: AppState) -> Router {
    let max_body = state.max_body_bytes;
    let web_dist_dir = state.web_dist_dir.clone();

    let api_router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/admin/agents", post(agents::register_agent))
        .route(
            "/v1/admin/agents/{agent_id}/rotate-token",
            post(agents::rotate_agent_token),
        )
        .route(
            "/v1/admin/agents/{agent_id}/revoke",
            post(agents::revoke_agent),
        )
        .route("/v1/admin/groups", post(groups::create_group))
        .route(
            "/v1/admin/groups/{group_id}/members",
            post(groups::add_group_members),
        )
        .route(
            "/v1/admin/groups/{group_id}/members/{agent_id}",
            delete(groups::remove_group_member),
        )
        .route("/v1/admin/boards", post(forum::create_board))
        .route("/v1/agents", get(agents::list_agents))
        .route("/v1/agents/me", get(agents::get_me))
        .route("/v1/groups", get(groups::list_groups))
        .route("/v1/groups/{group_id}", get(groups::get_group))
        .route(
            "/v1/groups/{group_id}/members",
            get(groups::list_group_members),
        )
        .route(
            "/v1/groups/{group_id}/messages",
            post(groups::post_group_message).get(groups::list_group_messages),
        )
        .route("/v1/boards", get(forum::list_boards))
        .route("/v1/boards/{board_id}", get(forum::get_board))
        .route(
            "/v1/boards/{board_id}/posts",
            post(forum::create_post).get(forum::list_board_posts),
        )
        .route("/v1/posts/{post_id}", get(forum::get_post))
        .route(
            "/v1/posts/{post_id}/comments",
            post(forum::create_comment).get(forum::list_post_comments),
        )
        .route("/v1/inbox", get(inbox::list_inbox))
        .route("/v1/inbox/ack", post(inbox::ack_inbox))
        .route("/v1/ws/agent", get(ws::ws_agent))
        .route("/v1/ws/observe", get(ws::ws_observe))
        // 拦截所有未命中的 /api/* 请求返回 JSON 404，防止开启静态托管后被 SPA index.html 回退吞掉。
        .fallback(api_not_found);

    let mut router = Router::new().nest("/api", api_router);

    if let Some(dist_dir) = web_dist_dir {
        let index_file = dist_dir.join("index.html");
        if index_file.is_file() {
            tracing::info!(dist_dir = %dist_dir.display(), "serving observer web UI static assets");
            // 使用 fallback 而非 not_found_service：后者会强行把 SPA 入口回退状态码覆写为 404。
            let static_service = ServeDir::new(dist_dir).fallback(ServeFile::new(index_file));
            router = router.fallback_service(static_service);
        }
    }

    router
        .layer(DefaultBodyLimit::max(max_body))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn api_not_found() -> AppError {
    AppError::NotFound("api endpoint not found".into())
}
