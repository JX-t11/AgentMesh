use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Request, State};
use axum::http::{header, HeaderName, HeaderValue, Request as HttpRequest};
use axum::middleware::Next;
use axum::response::Response;
use dashmap::DashMap;
use uuid::Uuid;

use crate::auth::AdminAuth;
use crate::state::AppState;

const X_REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

#[derive(Clone, Default)]
pub struct Metrics {
    inner: Arc<MetricsInner>,
}

#[derive(Default)]
struct MetricsInner {
    requests_total: AtomicU64,
    requests_in_flight: AtomicI64,
    responses: DashMap<(String, u16), u64>,
}

impl Metrics {
    pub fn start_request(&self, route: &str) {
        self.inner.requests_total.fetch_add(1, Ordering::Relaxed);
        self.inner
            .requests_in_flight
            .fetch_add(1, Ordering::Relaxed);
        self.inner
            .responses
            .entry((route.to_owned(), 0))
            .and_modify(|count| *count += 1)
            .or_insert(1);
    }

    pub fn finish_request(&self, route: &str, status: u16, elapsed: std::time::Duration) {
        self.inner
            .requests_in_flight
            .fetch_sub(1, Ordering::Relaxed);
        self.inner
            .responses
            .entry((route.to_owned(), status))
            .and_modify(|count| *count += 1)
            .or_insert(1);
        tracing::info!(
            route = %route,
            status = status,
            duration_ms = elapsed.as_millis() as u64,
            "http request"
        );
    }

    pub fn render(&self) -> String {
        let mut lines = Vec::with_capacity(32);
        lines.push("# HELP agentmesh_http_requests_total Total HTTP requests.".to_owned());
        lines.push("# TYPE agentmesh_http_requests_total counter".to_owned());
        lines.push(format!(
            "agentmesh_http_requests_total {}",
            self.inner.requests_total.load(Ordering::Relaxed)
        ));
        lines.push("# HELP agentmesh_http_requests_in_flight Current HTTP requests.".to_owned());
        lines.push("# TYPE agentmesh_http_requests_in_flight gauge".to_owned());
        lines.push(format!(
            "agentmesh_http_requests_in_flight {}",
            self.inner.requests_in_flight.load(Ordering::Relaxed)
        ));

        lines.push(
            "# HELP agentmesh_http_responses_total HTTP responses by route and status.".to_owned(),
        );
        lines.push("# TYPE agentmesh_http_responses_total counter".to_owned());
        let responses: BTreeMap<(String, u16), u64> = self
            .inner
            .responses
            .iter()
            .map(|entry| (entry.key().clone(), *entry.value()))
            .collect();
        for ((route, status), count) in responses {
            if status == 0 {
                continue;
            }
            lines.push(format!(
                "agentmesh_http_responses_total{{route=\"{route}\",status=\"{status}\"}} {count}"
            ));
        }
        lines.join("\n") + "\n"
    }
}

pub async fn track_http(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|matched| matched.as_str().to_owned())
        .unwrap_or_else(|| "unmatched".to_owned());
    let started = Instant::now();
    state.metrics.start_request(&route);
    let response = next.run(request).await;
    state
        .metrics
        .finish_request(&route, response.status().as_u16(), started.elapsed());
    response
}

pub async fn request_id(mut request: HttpRequest<axum::body::Body>, next: Next) -> Response {
    let provided = request
        .headers()
        .get(X_REQUEST_ID)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok())
        .map(|value| value.to_string());
    let request_id = provided.unwrap_or_else(|| Uuid::new_v4().to_string());
    request.headers_mut().insert(
        X_REQUEST_ID,
        HeaderValue::from_str(&request_id).expect("UUID is a valid header value"),
    );

    let mut response = next.run(request).await;
    response.headers_mut().insert(
        X_REQUEST_ID,
        HeaderValue::from_str(&request_id).expect("UUID is a valid header value"),
    );
    response
}

pub async fn metrics(
    _admin: AdminAuth,
    State(state): State<AppState>,
) -> impl axum::response::IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render(),
    )
}
