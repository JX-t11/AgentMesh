use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::types::Json as SqlxJson;
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{AdminAuth, UserAuth};
use crate::domain::types::{BoundedText, PageLimit};
use crate::error::{AppError, AppJson};
use crate::events::{encode_event, AgentSignal, EventHub};
use crate::routes::agents::AgentView;
use crate::routes::forum::{CommentView, PostView};
use crate::state::AppState;

use super::{decode_keyset_cursor, encode_keyset_cursor};

const POST_SELECT: &str =
    "SELECT id, board_id, author_agent_id, client_req_id, title, content, mention_agent_ids, \
            comment_count, last_activity_at, created_at";
const COMMENT_SELECT: &str =
    "SELECT id, post_id, comment_seq AS seq, author_agent_id, client_req_id, parent_comment_id, content, \
            mention_agent_ids, created_at";

#[derive(Deserialize)]
pub struct HideContentRequest {
    #[serde(default)]
    pub reason: Option<BoundedText<512>>,
}

#[derive(Deserialize)]
pub struct CreateReportRequest {
    pub reason: BoundedText<512>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ReportStatus {
    Pending,
    Resolved,
    Dismissed,
}

impl ReportStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Resolved => "resolved",
            Self::Dismissed => "dismissed",
        }
    }
}

#[derive(Deserialize)]
pub struct ListReportsQuery {
    pub status: Option<ReportStatus>,
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: PageLimit,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ResolveReportAction {
    Resolve,
    Dismiss,
}

#[derive(Deserialize)]
pub struct ResolveReportRequest {
    pub action: ResolveReportAction,
}

#[derive(Deserialize)]
pub struct BanAgentRequest {
    pub reason: BoundedText<512>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ContentReportView {
    pub id: Uuid,
    pub reporter_user_id: Uuid,
    pub reporter_username: Option<String>,
    pub post_id: Option<Uuid>,
    pub comment_id: Option<Uuid>,
    pub reason: String,
    pub status: String,
    pub resolved_by_user_id: Option<Uuid>,
    pub resolver_username: Option<String>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct ContentReportEnvelope {
    pub report: ContentReportView,
}

#[derive(Serialize)]
pub struct ContentReportListResponse {
    pub reports: Vec<ContentReportView>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AdminAuditLogView {
    pub actor_type: String,
    pub actor_user_id: Option<Uuid>,
    pub action: String,
    pub subject_type: String,
    pub subject_id: Uuid,
    pub reason: String,
    pub metadata_text: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct AdminAuditLogListResponse {
    pub logs: Vec<Value>,
}

pub async fn hide_post(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
    AppJson(req): AppJson<HideContentRequest>,
) -> Result<Json<crate::routes::forum::PostEnvelope>, AppError> {
    let reason = req
        .reason
        .as_ref()
        .map(|value| value.as_str())
        .unwrap_or("");
    let mut tx = state.db.begin().await?;
    let hidden = sqlx::query(
        "UPDATE posts
         SET hidden_at = NOW(), hidden_by_user_id = NULL, hidden_reason = $2, restored_at = NULL
         WHERE id = $1 AND hidden_at IS NULL",
    )
    .bind(post_id)
    .bind(reason)
    .execute(&mut *tx)
    .await?;

    let post = fetch_post(&mut *tx, post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("post not found".into()))?;
    if hidden.rows_affected() == 1 {
        insert_audit(
            &mut *tx,
            "admin",
            None,
            "post_hidden",
            "post",
            post_id,
            reason,
        )
        .await?;
        publish_forum_change(
            &mut *tx,
            &state.events,
            post.board_id,
            "post_hidden",
            post_id,
        )
        .await?;
    }
    tx.commit().await?;

    Ok(Json(crate::routes::forum::PostEnvelope { post }))
}

pub async fn restore_post(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
) -> Result<Json<crate::routes::forum::PostEnvelope>, AppError> {
    let mut tx = state.db.begin().await?;
    let restored = sqlx::query(
        "UPDATE posts
         SET hidden_at = NULL, hidden_by_user_id = NULL, hidden_reason = '', restored_at = NOW()
         WHERE id = $1 AND hidden_at IS NOT NULL",
    )
    .bind(post_id)
    .execute(&mut *tx)
    .await?;

    let post = fetch_post(&mut *tx, post_id)
        .await?
        .ok_or_else(|| AppError::NotFound("post not found".into()))?;
    if restored.rows_affected() == 1 {
        insert_audit(
            &mut *tx,
            "admin",
            None,
            "post_restored",
            "post",
            post_id,
            "",
        )
        .await?;
        publish_forum_change(
            &mut *tx,
            &state.events,
            post.board_id,
            "post_restored",
            post_id,
        )
        .await?;
    }
    tx.commit().await?;

    Ok(Json(crate::routes::forum::PostEnvelope { post }))
}

pub async fn hide_comment(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(comment_id): Path<Uuid>,
    AppJson(req): AppJson<HideContentRequest>,
) -> Result<Json<crate::routes::forum::CommentEnvelope>, AppError> {
    let reason = req
        .reason
        .as_ref()
        .map(|value| value.as_str())
        .unwrap_or("");
    let mut tx = state.db.begin().await?;
    let hidden = sqlx::query(
        "UPDATE comments
         SET hidden_at = NOW(), hidden_by_user_id = NULL, hidden_reason = $2, restored_at = NULL
         WHERE id = $1 AND hidden_at IS NULL",
    )
    .bind(comment_id)
    .bind(reason)
    .execute(&mut *tx)
    .await?;

    let comment = fetch_comment(&mut *tx, comment_id)
        .await?
        .ok_or_else(|| AppError::NotFound("comment not found".into()))?;
    if hidden.rows_affected() == 1 {
        sqlx::query(
            "UPDATE posts
             SET comment_count = GREATEST(comment_count - 1, 0)
             WHERE id = $1",
        )
        .bind(comment.post_id)
        .execute(&mut *tx)
        .await?;
        let board_id = post_board_id(&mut *tx, comment.post_id).await?;
        insert_audit(
            &mut *tx,
            "admin",
            None,
            "comment_hidden",
            "comment",
            comment_id,
            reason,
        )
        .await?;
        publish_forum_change(
            &mut *tx,
            &state.events,
            board_id,
            "comment_hidden",
            comment_id,
        )
        .await?;
    }
    let post_comment_count: i32 =
        sqlx::query_scalar("SELECT comment_count FROM posts WHERE id = $1")
            .bind(comment.post_id)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;

    Ok(Json(crate::routes::forum::CommentEnvelope {
        comment,
        post_comment_count,
    }))
}

pub async fn restore_comment(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(comment_id): Path<Uuid>,
) -> Result<Json<crate::routes::forum::CommentEnvelope>, AppError> {
    let mut tx = state.db.begin().await?;
    let restored = sqlx::query(
        "UPDATE comments
         SET hidden_at = NULL, hidden_by_user_id = NULL, hidden_reason = '', restored_at = NOW()
         WHERE id = $1 AND hidden_at IS NOT NULL",
    )
    .bind(comment_id)
    .execute(&mut *tx)
    .await?;

    let comment = fetch_comment(&mut *tx, comment_id)
        .await?
        .ok_or_else(|| AppError::NotFound("comment not found".into()))?;
    if restored.rows_affected() == 1 {
        sqlx::query("UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1")
            .bind(comment.post_id)
            .execute(&mut *tx)
            .await?;
        let board_id = post_board_id(&mut *tx, comment.post_id).await?;
        insert_audit(
            &mut *tx,
            "admin",
            None,
            "comment_restored",
            "comment",
            comment_id,
            "",
        )
        .await?;
        publish_forum_change(
            &mut *tx,
            &state.events,
            board_id,
            "comment_restored",
            comment_id,
        )
        .await?;
    }
    let post_comment_count: i32 =
        sqlx::query_scalar("SELECT comment_count FROM posts WHERE id = $1")
            .bind(comment.post_id)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;

    Ok(Json(crate::routes::forum::CommentEnvelope {
        comment,
        post_comment_count,
    }))
}

pub async fn create_post_report(
    auth: UserAuth,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
    AppJson(req): AppJson<CreateReportRequest>,
) -> Result<(StatusCode, Json<ContentReportEnvelope>), AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM posts WHERE id = $1 AND hidden_at IS NULL)",
    )
    .bind(post_id)
    .fetch_one(&state.db)
    .await?;
    if !exists {
        return Err(AppError::NotFound("post not found".into()));
    }
    create_report(
        &state,
        auth.user.id,
        Some(post_id),
        None,
        req.reason.as_str(),
    )
    .await
}

pub async fn create_comment_report(
    auth: UserAuth,
    State(state): State<AppState>,
    Path(comment_id): Path<Uuid>,
    AppJson(req): AppJson<CreateReportRequest>,
) -> Result<(StatusCode, Json<ContentReportEnvelope>), AppError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM comments WHERE id = $1 AND hidden_at IS NULL)",
    )
    .bind(comment_id)
    .fetch_one(&state.db)
    .await?;
    if !exists {
        return Err(AppError::NotFound("comment not found".into()));
    }
    create_report(
        &state,
        auth.user.id,
        None,
        Some(comment_id),
        req.reason.as_str(),
    )
    .await
}

pub async fn list_reports(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Query(query): Query<ListReportsQuery>,
) -> Result<Json<ContentReportListResponse>, AppError> {
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_keyset_cursor)
        .transpose()?;
    let mut sql = String::from(
        "SELECT r.id, r.reporter_user_id, u.username AS reporter_username,
                r.post_id, r.comment_id, r.reason, r.status,
                r.resolved_by_user_id, resolver.username AS resolver_username,
                r.resolved_at, r.created_at
         FROM content_reports r
         JOIN users u ON u.id = r.reporter_user_id
         LEFT JOIN users resolver ON resolver.id = r.resolved_by_user_id
         WHERE TRUE",
    );
    if let Some(status) = query.status {
        sql.push_str(" AND r.status = '");
        sql.push_str(status.as_str());
        sql.push('\'');
    }
    if let Some((timestamp, id)) = cursor {
        sql.push_str(&format!(
            " AND (r.created_at, r.id) < ('{timestamp}', '{id}')"
        ));
    }
    sql.push_str(" ORDER BY r.created_at DESC, r.id DESC LIMIT ");
    sql.push_str(&(query.limit.get() + 1).to_string());

    let mut reports = sqlx::query_as::<_, ContentReportView>(&sql)
        .fetch_all(&state.db)
        .await?;
    let has_more = reports.len() as i64 > query.limit.get();
    if has_more {
        reports.pop();
    }
    let next_cursor = has_more
        .then(|| {
            reports
                .last()
                .map(|report| encode_keyset_cursor(report.created_at, report.id))
        })
        .flatten();

    Ok(Json(ContentReportListResponse {
        reports,
        next_cursor,
        has_more,
    }))
}

pub async fn resolve_report(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(report_id): Path<Uuid>,
    AppJson(req): AppJson<ResolveReportRequest>,
) -> Result<Json<ContentReportEnvelope>, AppError> {
    let status = match req.action {
        ResolveReportAction::Resolve => "resolved",
        ResolveReportAction::Dismiss => "dismissed",
    };
    let report = sqlx::query_as::<_, ContentReportView>(
        "WITH updated AS (
             UPDATE content_reports
             SET status = $2, resolved_by_user_id = $3, resolved_at = NOW()
             WHERE id = $1 AND status = 'pending'
             RETURNING id, reporter_user_id, post_id, comment_id, reason, status,
                       resolved_by_user_id, resolved_at, created_at
         )
         SELECT up.id, up.reporter_user_id, u.username AS reporter_username,
                up.post_id, up.comment_id, up.reason, up.status,
                up.resolved_by_user_id, resolver.username AS resolver_username,
                up.resolved_at, up.created_at
         FROM updated up
         JOIN users u ON u.id = up.reporter_user_id
         LEFT JOIN users resolver ON resolver.id = up.resolved_by_user_id",
    )
    .bind(report_id)
    .bind(status)
    .bind(None::<Uuid>)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("pending report not found".into()))?;

    insert_audit(
        &state.db,
        "admin",
        None,
        "content_report_resolved",
        "content_report",
        report_id,
        status,
    )
    .await?;

    Ok(Json(ContentReportEnvelope { report }))
}

pub async fn ban_agent(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(agent_id): Path<Uuid>,
    AppJson(req): AppJson<BanAgentRequest>,
) -> Result<Json<crate::routes::agents::AgentEnvelope>, AppError> {
    let reason = req.reason.as_str();
    let agent = sqlx::query_as::<_, AgentView>(
        "WITH updated AS (
             UPDATE agents
             SET banned_at = COALESCE(banned_at, NOW())
             WHERE id = $1
             RETURNING id, slug, display_name, framework, description, capabilities,
                       owner_user_id, revoked_at, banned_at, created_at
         )
         SELECT up.id, up.slug, up.display_name, up.framework, up.description, up.capabilities,
                up.owner_user_id, u.username AS owner_username,
                (up.revoked_at IS NOT NULL) AS is_revoked,
                (up.banned_at IS NOT NULL) AS is_banned, up.created_at
         FROM updated up
         LEFT JOIN users u ON u.id = up.owner_user_id",
    )
    .bind(agent_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("agent not found".into()))?;

    state.auth_cache.revoke(agent_id);
    state.events.send_agent(agent_id, AgentSignal::Revoke);
    insert_audit(
        &state.db,
        "admin",
        None,
        "agent_ban",
        "agent",
        agent_id,
        reason,
    )
    .await?;

    Ok(Json(crate::routes::agents::AgentEnvelope { agent }))
}

pub async fn unban_agent(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(agent_id): Path<Uuid>,
) -> Result<Json<crate::routes::agents::AgentEnvelope>, AppError> {
    let row: Option<(Option<Vec<u8>>,)> = sqlx::query_as(
        "WITH updated AS (
             UPDATE agents
             SET banned_at = NULL
             WHERE id = $1
             RETURNING id, slug, display_name, framework, description, capabilities,
                       owner_user_id, revoked_at, banned_at, token_sha256, created_at
         )
         SELECT up.token_sha256 FROM updated up",
    )
    .bind(agent_id)
    .fetch_optional(&state.db)
    .await?;

    let (token_hash,) = row.ok_or_else(|| AppError::NotFound("agent not found".into()))?;
    let agent = sqlx::query_as::<_, AgentView>(
        "SELECT a.id, a.slug, a.display_name, a.framework, a.description, a.capabilities,
                a.owner_user_id, u.username AS owner_username,
                (a.revoked_at IS NOT NULL) AS is_revoked,
                (a.banned_at IS NOT NULL) AS is_banned, a.created_at
         FROM agents a
         LEFT JOIN users u ON u.id = a.owner_user_id
         WHERE a.id = $1",
    )
    .bind(agent_id)
    .fetch_one(&state.db)
    .await?;

    if let Some(hash) = token_hash {
        if agent.is_revoked {
            state.auth_cache.revoke(agent_id);
        } else if let Ok(hash) = <[u8; 32]>::try_from(hash.as_slice()) {
            state.auth_cache.upsert(
                hash,
                crate::auth::AgentPrincipal {
                    id: agent.id,
                    slug: agent.slug.clone(),
                    display_name: agent.display_name.clone(),
                    framework: agent.framework.clone(),
                },
            );
        }
    }
    insert_audit(
        &state.db,
        "admin",
        None,
        "agent_unban",
        "agent",
        agent_id,
        "",
    )
    .await?;

    Ok(Json(crate::routes::agents::AgentEnvelope { agent }))
}

pub async fn list_audit_logs(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Query(query): Query<ListAuditLogsQuery>,
) -> Result<Json<AdminAuditLogListResponse>, AppError> {
    let rows = sqlx::query_as::<_, AdminAuditLogView>(
        "SELECT actor_type, actor_user_id, action, subject_type, subject_id, reason,
                metadata::text AS metadata_text, created_at
         FROM admin_audit_logs
         ORDER BY created_at DESC, id DESC
         LIMIT $1",
    )
    .bind(query.limit.get())
    .fetch_all(&state.db)
    .await?;

    let logs = rows
        .into_iter()
        .map(|row| {
            json!({
                "actor_type": row.actor_type,
                "actor_user_id": row.actor_user_id,
                "action": row.action,
                "subject_type": row.subject_type,
                "subject_id": row.subject_id,
                "reason": row.reason,
                "metadata": serde_json::from_str::<Value>(&row.metadata_text)
                    .unwrap_or_else(|_| json!({})),
                "created_at": row.created_at,
            })
        })
        .collect();

    Ok(Json(AdminAuditLogListResponse { logs }))
}

#[derive(Deserialize)]
pub struct ListAuditLogsQuery {
    #[serde(default)]
    pub limit: PageLimit,
}

#[allow(clippy::too_many_arguments)]
async fn insert_audit<'e, E>(
    executor: E,
    actor_type: &str,
    actor_user_id: Option<Uuid>,
    action: &str,
    subject_type: &str,
    subject_id: Uuid,
    reason: &str,
) -> Result<(), sqlx::Error>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query(
        "INSERT INTO admin_audit_logs
             (actor_type, actor_user_id, action, subject_type, subject_id, reason, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(actor_type)
    .bind(actor_user_id)
    .bind(action)
    .bind(subject_type)
    .bind(subject_id)
    .bind(reason)
    .bind(SqlxJson(json!({})))
    .execute(executor)
    .await?;
    Ok(())
}

async fn create_report(
    state: &AppState,
    reporter_user_id: Uuid,
    post_id: Option<Uuid>,
    comment_id: Option<Uuid>,
    reason: &str,
) -> Result<(StatusCode, Json<ContentReportEnvelope>), AppError> {
    let report = sqlx::query_as::<_, ContentReportView>(
        "WITH inserted AS (
             INSERT INTO content_reports (id, reporter_user_id, post_id, comment_id, reason)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, reporter_user_id, post_id, comment_id, reason, status,
                       resolved_by_user_id, resolved_at, created_at
         )
         SELECT ins.id, ins.reporter_user_id, u.username AS reporter_username,
                ins.post_id, ins.comment_id, ins.reason, ins.status,
                ins.resolved_by_user_id, NULL::text AS resolver_username,
                ins.resolved_at, ins.created_at
         FROM inserted ins
         JOIN users u ON u.id = ins.reporter_user_id",
    )
    .bind(Uuid::new_v4())
    .bind(reporter_user_id)
    .bind(post_id)
    .bind(comment_id)
    .bind(reason)
    .fetch_one(&state.db)
    .await
    .map_err(map_open_report_conflict)?;

    insert_audit(
        &state.db,
        "user",
        Some(reporter_user_id),
        "content_report_created",
        "content_report",
        report.id,
        reason,
    )
    .await?;

    Ok((StatusCode::CREATED, Json(ContentReportEnvelope { report })))
}

async fn fetch_post<'e, E>(executor: E, post_id: Uuid) -> Result<Option<PostView>, sqlx::Error>
where
    E: sqlx::PgExecutor<'e>,
{
    let sql = format!("{POST_SELECT} FROM posts WHERE id = $1");
    sqlx::query_as::<_, PostView>(&sql)
        .bind(post_id)
        .fetch_optional(executor)
        .await
}

async fn fetch_comment<'e, E>(
    executor: E,
    comment_id: Uuid,
) -> Result<Option<CommentView>, sqlx::Error>
where
    E: sqlx::PgExecutor<'e>,
{
    let sql = format!("{COMMENT_SELECT} FROM comments WHERE id = $1");
    sqlx::query_as::<_, CommentView>(&sql)
        .bind(comment_id)
        .fetch_optional(executor)
        .await
}

async fn post_board_id<'e, E>(executor: E, post_id: Uuid) -> Result<Uuid, sqlx::Error>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query_scalar("SELECT board_id FROM posts WHERE id = $1")
        .bind(post_id)
        .fetch_one(executor)
        .await
}

async fn publish_forum_change<'e, E>(
    executor: E,
    events: &EventHub,
    board_id: Uuid,
    event_type: &str,
    subject_id: Uuid,
) -> Result<(), sqlx::Error>
where
    E: sqlx::PgExecutor<'e>,
{
    let visibility: String = sqlx::query_scalar("SELECT visibility FROM boards WHERE id = $1")
        .bind(board_id)
        .fetch_one(executor)
        .await?;
    let frame = encode_event(&json!({
        "type": event_type,
        "post_id": subject_id,
    }));
    events.publish_forum_scoped(frame, visibility == "public");
    Ok(())
}

fn map_open_report_conflict(err: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &err {
        if db_err
            .constraint()
            .is_some_and(|name| name.starts_with("uq_content_reports_open"))
        {
            return AppError::Conflict("an open report already exists for this content".into());
        }
    }
    AppError::from(err)
}
