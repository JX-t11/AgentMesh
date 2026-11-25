use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{generate_user_token, hash_password, verify_password, UserAuth, UserPrincipal};
use crate::domain::types::{PasswordText, ShortName, Slug};
use crate::error::{AppError, AppJson};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct RegisterUserRequest {
    pub username: Slug,
    pub display_name: ShortName,
    pub password: PasswordText,
}

#[derive(Deserialize)]
pub struct LoginUserRequest {
    pub username: Slug,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct UserView {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct IssuedUserSessionResponse {
    pub user: UserView,
    pub token: String,
}

#[derive(Serialize)]
pub struct UserEnvelope {
    pub user: UserView,
}

#[derive(FromRow)]
struct UserAuthRow {
    id: Uuid,
    username: String,
    display_name: String,
    password_salt: Vec<u8>,
    password_hash: Vec<u8>,
    created_at: DateTime<Utc>,
}

pub async fn register_user(
    State(state): State<AppState>,
    AppJson(req): AppJson<RegisterUserRequest>,
) -> Result<(StatusCode, Json<IssuedUserSessionResponse>), AppError> {
    let user_id = Uuid::new_v4();
    let (salt, password_hash) = hash_password(req.password.as_str());
    let (token, token_hash) = generate_user_token();
    let expires_at = Utc::now() + state.session_ttl;

    let mut tx = state.db.begin().await?;
    let user = sqlx::query_as::<_, UserView>(
        "INSERT INTO users (id, username, display_name, password_salt, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, display_name, created_at",
    )
    .bind(user_id)
    .bind(req.username.as_str())
    .bind(req.display_name.as_str())
    .bind(salt.as_slice())
    .bind(password_hash.as_slice())
    .fetch_one(&mut *tx)
    .await
    .map_err(map_unique_username_conflict)?;

    sqlx::query(
        "INSERT INTO user_sessions (token_sha256, user_id, expires_at) VALUES ($1, $2, $3)",
    )
    .bind(token_hash.as_slice())
    .bind(user.id)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    state.auth_cache.upsert_user_session(
        token_hash,
        UserPrincipal {
            id: user.id,
            username: user.username.clone(),
            display_name: user.display_name.clone(),
            expires_at,
        },
    );

    Ok((
        StatusCode::CREATED,
        Json(IssuedUserSessionResponse { user, token }),
    ))
}

pub async fn login_user(
    State(state): State<AppState>,
    AppJson(req): AppJson<LoginUserRequest>,
) -> Result<Json<IssuedUserSessionResponse>, AppError> {
    let username = req.username.as_str();
    if state.login_rate_limiter.is_blocked(
        username,
        state.login_max_attempts,
        state.login_rate_window,
    ) {
        return Err(AppError::RateLimited(
            "too many failed login attempts; try again later".into(),
        ));
    }

    let row = sqlx::query_as::<_, UserAuthRow>(
        "SELECT id, username, display_name, password_salt, password_hash, created_at
         FROM users
         WHERE username = $1",
    )
    .bind(username)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        state
            .login_rate_limiter
            .record_failure(username, state.login_rate_window);
        AppError::Unauthorized("invalid username or password".into())
    })?;

    if !verify_password(&req.password, &row.password_salt, &row.password_hash) {
        state
            .login_rate_limiter
            .record_failure(username, state.login_rate_window);
        return Err(AppError::Unauthorized(
            "invalid username or password".into(),
        ));
    }
    state.login_rate_limiter.clear(username);

    let (token, token_hash) = generate_user_token();
    let expires_at = Utc::now() + state.session_ttl;
    sqlx::query(
        "INSERT INTO user_sessions (token_sha256, user_id, expires_at) VALUES ($1, $2, $3)",
    )
    .bind(token_hash.as_slice())
    .bind(row.id)
    .bind(expires_at)
    .execute(&state.db)
    .await?;

    let user = UserView {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        created_at: row.created_at,
    };

    state.auth_cache.upsert_user_session(
        token_hash,
        UserPrincipal {
            id: user.id,
            username: user.username.clone(),
            display_name: user.display_name.clone(),
            expires_at,
        },
    );

    Ok(Json(IssuedUserSessionResponse { user, token }))
}

pub async fn get_current_user(
    auth: UserAuth,
    State(state): State<AppState>,
) -> Result<Json<UserEnvelope>, AppError> {
    let user = sqlx::query_as::<_, UserView>(
        "SELECT id, username, display_name, created_at FROM users WHERE id = $1",
    )
    .bind(auth.user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Unauthorized("user no longer exists".into()))?;

    Ok(Json(UserEnvelope { user }))
}

pub async fn logout_user(
    auth: UserAuth,
    State(state): State<AppState>,
) -> Result<StatusCode, AppError> {
    sqlx::query("DELETE FROM user_sessions WHERE token_sha256 = $1")
        .bind(auth.token_hash.as_slice())
        .execute(&state.db)
        .await?;
    state.auth_cache.remove_user_session(&auth.token_hash);
    Ok(StatusCode::NO_CONTENT)
}

fn map_unique_username_conflict(err: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &err {
        if db_err.code().as_deref() == Some("23505") {
            return AppError::Conflict("username already exists".into());
        }
    }
    AppError::from(err)
}
