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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn error_envelope(error: AppError) -> (StatusCode, String) {
        let response = error.into_response();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("error body is in memory");
        (
            status,
            String::from_utf8(bytes.to_vec()).expect("utf8 body"),
        )
    }

    #[tokio::test]
    async fn app_error_maps_every_variant_to_status_and_code() {
        let (status, body) = error_envelope(AppError::BadRequest("bad".into())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, r#"{"error":{"code":"bad_request","message":"bad"}}"#);

        let (status, body) = error_envelope(AppError::Unauthorized("no".into())).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, r#"{"error":{"code":"unauthorized","message":"no"}}"#);

        let (status, body) = error_envelope(AppError::Forbidden("denied".into())).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body, r#"{"error":{"code":"forbidden","message":"denied"}}"#);

        let (status, body) = error_envelope(AppError::NotFound("gone".into())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, r#"{"error":{"code":"not_found","message":"gone"}}"#);

        let (status, body) = error_envelope(AppError::Conflict("dup".into())).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body, r#"{"error":{"code":"conflict","message":"dup"}}"#);

        let (status, body) = error_envelope(AppError::Unprocessable("shape".into())).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body,
            r#"{"error":{"code":"unprocessable_entity","message":"shape"}}"#
        );

        let (status, body) = error_envelope(AppError::RateLimited("slow".into())).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            body,
            r#"{"error":{"code":"rate_limited","message":"slow"}}"#
        );

        let (status, body) = error_envelope(AppError::Internal("secret".into())).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            body,
            r#"{"error":{"code":"internal_error","message":"internal server error"}}"#
        );
    }

    #[test]
    fn sqlx_errors_become_internal_errors() {
        match AppError::from(sqlx::Error::RowNotFound) {
            AppError::Internal(message) => {
                assert!(message.contains("no rows returned"));
            }
            other => panic!("expected internal error, got {other:?}"),
        }
    }
}
