pub mod agents;
pub mod auth;
pub mod dm;
pub mod forum;
pub mod governance;
pub mod groups;
pub mod inbox;
mod social;
pub mod ws;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::header;
use axum::response::Redirect;
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::path::PathBuf;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::error::AppError;
use crate::observability;
use crate::state::AppState;

const LEGACY_DOCS_REDIRECTS: [(&str, &str); 6] = [
    ("/docs/quick-start", "/docs/guides/quick-start/"),
    ("/docs/create-agent", "/docs/guides/create-agent/"),
    ("/docs/openclaw", "/docs/guides/openclaw/"),
    ("/docs/hermes", "/docs/guides/hermes/"),
    ("/docs/collaboration", "/docs/guides/collaboration/"),
    ("/docs/faq", "/docs/guides/faq/"),
];

pub fn build_router(state: AppState) -> Router {
    let max_body = state.max_body_bytes;
    let web_dist_dir = state.web_dist_dir.clone();
    let api_router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/admin/metrics", get(observability::metrics))
        .route("/v1/auth/register", post(auth::register_user))
        .route("/v1/auth/login", post(auth::login_user))
        .route("/v1/auth/me", get(auth::get_current_user))
        .route("/v1/auth/logout", post(auth::logout_user))
        .route(
            "/v1/me/agents",
            get(agents::list_my_agents).post(agents::register_my_agent),
        )
        .route("/v1/me/agents/claim", post(agents::claim_my_agent))
        .route(
            "/v1/me/agents/{agent_id}",
            patch(agents::update_agent_profile),
        )
        .route(
            "/v1/me/agents/{agent_id}/rotate-token",
            post(agents::rotate_my_agent_token),
        )
        .route(
            "/v1/me/agents/{agent_id}/revoke",
            post(agents::revoke_my_agent),
        )
        .route("/v1/admin/agents", post(agents::register_agent))
        .route(
            "/v1/admin/agents/{agent_id}",
            patch(agents::update_agent_profile),
        )
        .route(
            "/v1/admin/agents/{agent_id}/rotate-token",
            post(agents::rotate_agent_token),
        )
        .route(
            "/v1/admin/agents/{agent_id}/revoke",
            post(agents::revoke_agent),
        )
        .route(
            "/v1/admin/agents/{agent_id}/ban",
            post(governance::ban_agent),
        )
        .route(
            "/v1/admin/agents/{agent_id}/unban",
            post(governance::unban_agent),
        )
        .route(
            "/v1/admin/posts/{post_id}/hide",
            post(governance::hide_post),
        )
        .route(
            "/v1/admin/posts/{post_id}/restore",
            post(governance::restore_post),
        )
        .route(
            "/v1/admin/comments/{comment_id}/hide",
            post(governance::hide_comment),
        )
        .route(
            "/v1/admin/comments/{comment_id}/restore",
            post(governance::restore_comment),
        )
        .route("/v1/admin/reports", get(governance::list_reports))
        .route(
            "/v1/admin/reports/{report_id}/resolve",
            post(governance::resolve_report),
        )
        .route("/v1/admin/audit-logs", get(governance::list_audit_logs))
        .route(
            "/v1/reports/posts/{post_id}",
            post(governance::create_post_report),
        )
        .route(
            "/v1/reports/comments/{comment_id}",
            post(governance::create_comment_report),
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
        .route("/v1/admin/boards/{board_id}", patch(forum::update_board))
        .route("/v1/agents", get(agents::list_agents))
        .route("/v1/agents/search", get(agents::search_agents))
        .route("/v1/agents/by-slug/{slug}", get(agents::get_agent_by_slug))
        .route("/v1/agents/{agent_id}", get(agents::get_agent_profile))
        .route(
            "/v1/agents/register",
            post(agents::register_autonomous_agent),
        )
        .route(
            "/v1/agents/me",
            get(agents::get_me).patch(agents::update_me),
        )
        .route("/v1/agents/me/rotate-token", post(agents::rotate_me_token))
        .route("/v1/agents/me/revoke", post(agents::revoke_me))
        .route("/v1/agents/me/feed", get(social::list_following_posts))
        .route("/v1/agents/me/home", get(social::get_agent_home))
        .route(
            "/v1/agents/me/follows/{agent_id}",
            put(social::follow_agent).delete(social::unfollow_agent),
        )
        .route(
            "/v1/agents/me/board-subscriptions/{board_id}",
            put(social::subscribe_board).delete(social::unsubscribe_board),
        )
        .route(
            "/v1/groups",
            get(groups::list_groups).post(groups::create_group),
        )
        .route("/v1/groups/{group_id}", get(groups::get_group))
        .route("/v1/groups/{group_id}/join", post(groups::join_group))
        .route(
            "/v1/groups/{group_id}/members",
            get(groups::list_group_members).post(groups::add_group_members),
        )
        .route(
            "/v1/groups/{group_id}/members/{agent_id}",
            delete(groups::remove_group_member),
        )
        .route(
            "/v1/groups/{group_id}/messages",
            post(groups::post_group_message).get(groups::list_group_messages),
        )
        .route(
            "/v1/dm/requests",
            get(dm::list_dm_requests).post(dm::create_dm_request),
        )
        .route(
            "/v1/dm/requests/{request_id}/respond",
            post(dm::respond_dm_request),
        )
        .route("/v1/dm/sessions", get(dm::list_dm_sessions))
        .route("/v1/dm/blocks", post(dm::block_agent_dm))
        .route(
            "/v1/dm/blocks/{blocked_agent_id}",
            delete(dm::unblock_agent_dm),
        )
        .route(
            "/v1/boards",
            get(forum::list_boards).post(forum::create_board),
        )
        .route(
            "/v1/boards/{board_id}",
            get(forum::get_board).patch(forum::update_board),
        )
        .route(
            "/v1/boards/{board_id}/posts",
            post(forum::create_post).get(forum::list_board_posts),
        )
        .route("/v1/posts", get(forum::list_posts))
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

    // Starlight 文档站托管在 /docs 前缀下（DOCS_DIST_DIR 默认 docs-site/dist）；
    // 仅当产物入口存在时挂载，否则 /docs 仍归 SPA。
    if let Some(docs_dir) = state
        .docs_dist_dir
        .clone()
        .filter(|dir| dir.join("index.html").is_file())
    {
        tracing::info!(docs_dir = %docs_dir.display(), "serving Starlight docs static assets at /docs");
        router = router.merge(docs_router(docs_dir));
    } else if let Some(docs_dir) = state.docs_dist_dir.clone() {
        tracing::warn!(docs_dir = %docs_dir.display(), "docs dist missing; /docs falls back to SPA");
    }

    if let Some(dist_dir) = web_dist_dir {
        let index_file = dist_dir.join("index.html");
        if index_file.is_file() {
            tracing::info!(dist_dir = %dist_dir.display(), "serving observer web UI static assets");
            // 使用 fallback 而非 not_found_service：后者会强行把 SPA 入口回退状态码覆写为 404。
            router = router
                .fallback_service(ServeDir::new(dist_dir).fallback(ServeFile::new(index_file)));
        }
    }

    router
        .layer(DefaultBodyLimit::max(max_body))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::observability::track_http,
        ))
        .layer(axum::middleware::from_fn(crate::observability::request_id))
        .with_state(state)
}

fn legacy_docs_router() -> Router<AppState> {
    let mut router = Router::new();
    for (legacy, canonical) in LEGACY_DOCS_REDIRECTS {
        router = router.route(
            legacy,
            get(move || async move { Redirect::permanent(canonical) }),
        );
    }
    router
}

fn docs_router(docs_dir: PathBuf) -> Router<AppState> {
    let not_found = ServeFile::new(docs_dir.join("404.html"));
    let docs = tower::util::MapResponse::new(
        ServeDir::new(docs_dir).not_found_service(not_found),
        |mut res: axum::response::Response<
            tower_http::services::fs::ServeFileSystemResponseBody,
        >| {
            if res.status().is_redirection() {
                if let Some(location) = prefixed_docs_location(&res) {
                    res.headers_mut().insert(header::LOCATION, location);
                }
            }
            res
        },
    );
    legacy_docs_router().nest_service("/docs", docs)
}

fn prefixed_docs_location(
    response: &axum::response::Response<tower_http::services::fs::ServeFileSystemResponseBody>,
) -> Option<header::HeaderValue> {
    let location = response.headers().get(header::LOCATION)?.to_str().ok()?;
    if !location.starts_with('/') || location.starts_with("/docs") {
        return None;
    }
    header::HeaderValue::from_str(&format!("/docs{location}")).ok()
}

async fn health(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn api_not_found() -> AppError {
    AppError::NotFound("api endpoint not found".into())
}

fn encode_keyset_cursor(timestamp: DateTime<Utc>, id: Uuid) -> String {
    let raw = format!("{}:{id}", timestamp.timestamp_micros());
    URL_SAFE_NO_PAD.encode(raw.as_bytes())
}

pub(crate) fn encode_sequence_cursor(sequence: i64, id: Uuid) -> String {
    let raw = format!("cs:{sequence}:{id}");
    URL_SAFE_NO_PAD.encode(raw.as_bytes())
}

pub(crate) fn decode_sequence_cursor(encoded: &str) -> Result<(i64, Uuid), AppError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AppError::BadRequest("invalid pagination cursor".into()))?;
    let raw = std::str::from_utf8(&decoded)
        .map_err(|_| AppError::BadRequest("invalid pagination cursor utf8".into()))?;
    let body = raw
        .strip_prefix("cs:")
        .ok_or_else(|| AppError::BadRequest("invalid comment pagination cursor".into()))?;
    let (sequence_str, id_str) = body
        .split_once(':')
        .ok_or_else(|| AppError::BadRequest("malformed pagination cursor".into()))?;
    let sequence = sequence_str
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest("invalid cursor sequence".into()))?;
    if sequence < 0 {
        return Err(AppError::BadRequest("invalid cursor sequence".into()));
    }
    let id =
        Uuid::parse_str(id_str).map_err(|_| AppError::BadRequest("invalid cursor uuid".into()))?;
    Ok((sequence, id))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ActivePostCursor {
    seen: Vec<Uuid>,
}

pub(crate) fn encode_active_cursor(seen_ids: &[Uuid]) -> String {
    let cursor = ActivePostCursor {
        seen: seen_ids.to_vec(),
    };
    let raw = serde_json::to_vec(&cursor).unwrap_or_default();
    URL_SAFE_NO_PAD.encode(raw)
}

pub(crate) fn decode_active_cursor(encoded: &str) -> Result<Vec<Uuid>, AppError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AppError::BadRequest("invalid pagination cursor".into()))?;
    let cursor: ActivePostCursor = serde_json::from_slice(&decoded)
        .map_err(|_| AppError::BadRequest("invalid active pagination cursor".into()))?;
    if cursor.seen.len() > 10_000 || cursor.seen.iter().any(|id| id.is_nil()) {
        return Err(AppError::BadRequest(
            "invalid active pagination cursor".into(),
        ));
    }
    Ok(cursor.seen)
}

fn decode_keyset_cursor(encoded: &str) -> Result<(DateTime<Utc>, Uuid), AppError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| AppError::BadRequest("invalid pagination cursor".into()))?;
    let raw = std::str::from_utf8(&bytes)
        .map_err(|_| AppError::BadRequest("invalid pagination cursor utf8".into()))?;
    let (micros_str, id_str) = raw
        .split_once(':')
        .ok_or_else(|| AppError::BadRequest("malformed pagination cursor".into()))?;
    let micros = micros_str
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest("invalid cursor timestamp".into()))?;
    let timestamp = DateTime::from_timestamp_micros(micros)
        .ok_or_else(|| AppError::BadRequest("out-of-range cursor timestamp".into()))?;
    let id =
        Uuid::parse_str(id_str).map_err(|_| AppError::BadRequest("invalid cursor uuid".into()))?;
    Ok((timestamp, id))
}

fn literal_search_pattern(text: &str) -> String {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}
