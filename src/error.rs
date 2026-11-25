use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{FromRequest, FromRequestParts, Query};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::de::DeserializeOwned;
use serde::Serialize;

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized(String),
    Forbidden(String),
    NotFound(String),
    Conflict(String),
    Unprocessable(String),
    RateLimited(String),
    Internal(String),
}

#[derive(Serialize)]
struct ErrorEnvelope<'a> {
    error: ErrorBody<'a>,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'static str,
    message: &'a str,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            Self::BadRequest(msg) => (StatusCode::BAD_REQUEST, "bad_request", msg.as_str()),
            Self::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "unauthorized", msg.as_str()),
            Self::Forbidden(msg) => (StatusCode::FORBIDDEN, "forbidden", msg.as_str()),
            Self::NotFound(msg) => (StatusCode::NOT_FOUND, "not_found", msg.as_str()),
            Self::Conflict(msg) => (StatusCode::CONFLICT, "conflict", msg.as_str()),
            Self::Unprocessable(msg) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "unprocessable_entity",
                msg.as_str(),
            ),
            Self::RateLimited(msg) => (StatusCode::TOO_MANY_REQUESTS, "rate_limited", msg.as_str()),
            Self::Internal(err) => {
                tracing::error!(error = %err, "internal server error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "internal server error",
                )
            }
        };

        (
            status,
            Json(ErrorEnvelope {
                error: ErrorBody { code, message },
            }),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        Self::Internal(err.to_string())
    }
}

pub struct AppJson<T>(pub T);

impl<S, T> FromRequest<S> for AppJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = AppError;

    async fn from_request(req: axum::extract::Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(val)) => Ok(Self(val)),
            Err(rejection) => Err(map_json_rejection(rejection)),
        }
    }
}

fn map_json_rejection(rejection: JsonRejection) -> AppError {
    match rejection {
        JsonRejection::JsonDataError(err) => AppError::Unprocessable(err.body_text()),
        other => AppError::BadRequest(other.body_text()),
    }
}

pub struct AppQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for AppQuery<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Send,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(val)) => Ok(Self(val)),
            Err(QueryRejection::FailedToDeserializeQueryString(err)) => {
                Err(AppError::BadRequest(err.body_text()))
            }
            Err(other) => Err(AppError::BadRequest(other.body_text())),
        }
    }
}
