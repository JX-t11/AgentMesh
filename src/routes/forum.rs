use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::types::Json as SqlxJson;
use sqlx::{FromRow, Postgres, QueryBuilder};
use uuid::Uuid;

use crate::auth::{AdminAuth, AgentAuth, OptionalViewer};
use crate::domain::types::{
    BoardVisibility, ClientReqId, DescriptionText, MessageBody, PageLimit, PostTitle, ShortName,
    Slug, UniqueAgentIds,
};
use crate::error::{AppError, AppJson, AppQuery};
use crate::events::{encode_event, AgentSignal};
use crate::routes::groups::truncate_summary;
use crate::routes::inbox::InboxEventView;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateBoardRequest {
    pub slug: Slug,
    pub name: ShortName,
    #[serde(default)]
    pub description: DescriptionText,
    #[serde(default)]
    pub visibility: BoardVisibility,
}

#[derive(Deserialize)]
pub struct UpdateBoardRequest {
    pub name: Option<ShortName>,
    pub description: Option<DescriptionText>,
    pub visibility: Option<BoardVisibility>,
}

#[derive(Deserialize)]
pub struct CreatePostRequest {
    pub client_req_id: ClientReqId,
    pub title: PostTitle,
    pub content: MessageBody,
    #[serde(default)]
    pub mention_agent_ids: UniqueAgentIds,
}

#[derive(Deserialize)]
pub struct CreateCommentRequest {
    pub client_req_id: ClientReqId,
    pub content: MessageBody,
    pub parent_comment_id: Option<Uuid>,
    #[serde(default)]
    pub mention_agent_ids: UniqueAgentIds,
}

#[derive(Deserialize, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PostSortOrder {
    #[default]
    Active,
    Newest,
}

#[derive(Deserialize)]
pub struct ListBoardPostsQuery {
    #[serde(default)]
    pub sort: PostSortOrder,
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: PageLimit,
}

#[derive(Deserialize)]
pub struct ListPostCommentsQuery {
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: PageLimit,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct BoardView {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub visibility: String,
    pub creator_user_id: Option<Uuid>,
    pub post_count: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PostView {
    pub id: Uuid,
    pub board_id: Uuid,
    pub author_agent_id: Uuid,
    pub client_req_id: String,
    pub title: String,
    pub content: String,
    pub mention_agent_ids: Vec<Uuid>,
    pub comment_count: i32,
    pub last_activity_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct CommentView {
    pub id: Uuid,
    pub post_id: Uuid,
    pub author_agent_id: Uuid,
    pub client_req_id: String,
    pub parent_comment_id: Option<Uuid>,
    pub content: String,
    pub mention_agent_ids: Vec<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct BoardEnvelope {
    pub board: BoardView,
}

#[derive(Serialize)]
pub struct BoardListResponse {
    pub boards: Vec<BoardView>,
    pub hidden_platform_count: i64,
}

#[derive(Serialize)]
pub struct PostEnvelope {
    pub post: PostView,
}

#[derive(Serialize)]
pub struct PostListResponse {
    pub board_id: Option<Uuid>,
    pub posts: Vec<PostView>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Serialize)]
pub struct CommentEnvelope {
    pub comment: CommentView,
    pub post_comment_count: i32,
}

#[derive(Serialize)]
pub struct CommentListResponse {
    pub post_id: Uuid,
    pub comments: Vec<CommentView>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Deserialize)]
struct CreatedInboxEntry {
    recipient_agent_id: Uuid,
    inbox_seq: i64,
    kind: String,
    created_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct CreatePostCteRow {
    board_exists: bool,
    board_visibility: Option<String>,
    mentions_ok: bool,
    is_new: bool,
    existing_hash: Option<Vec<u8>>,
    post_id: Option<Uuid>,
    post_board_id: Option<Uuid>,
    title: Option<String>,
    content: Option<String>,
    mention_agent_ids: Option<Vec<Uuid>>,
    comment_count: Option<i32>,
    last_activity_at: Option<DateTime<Utc>>,
    created_at: Option<DateTime<Utc>>,
    inbox_entries: SqlxJson<Vec<CreatedInboxEntry>>,
}

#[derive(FromRow)]
struct CreateCommentCteRow {
    post_exists: bool,
    board_visibility: Option<String>,
    parent_ok: bool,
    mentions_ok: bool,
    is_new: bool,
    existing_hash: Option<Vec<u8>>,
    comment_id: Option<Uuid>,
    comment_post_id: Option<Uuid>,
    parent_comment_id: Option<Uuid>,
    content: Option<String>,
    mention_agent_ids: Option<Vec<Uuid>>,
    created_at: Option<DateTime<Utc>>,
    post_comment_count: Option<i32>,
    inbox_entries: SqlxJson<Vec<CreatedInboxEntry>>,
}

pub async fn create_board(
    _admin: AdminAuth,
    State(state): State<AppState>,
    AppJson(req): AppJson<CreateBoardRequest>,
) -> Result<(StatusCode, Json<BoardEnvelope>), AppError> {
    let id = Uuid::new_v4();
    let board = sqlx::query_as::<_, BoardView>(
        "INSERT INTO boards (id, slug, name, description, visibility, creator_user_id)
         VALUES ($1, $2, $3, $4, $5, NULL)
         RETURNING id, slug, name, description, visibility, creator_user_id,
                   0::bigint AS post_count, created_at",
    )
    .bind(id)
    .bind(req.slug.as_str())
    .bind(req.name.as_str())
    .bind(req.description.as_str())
    .bind(req.visibility.as_str())
    .fetch_one(&state.db)
    .await
    .map_err(map_board_slug_conflict)?;

    Ok((StatusCode::CREATED, Json(BoardEnvelope { board })))
}

pub async fn update_board(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    AppJson(req): AppJson<UpdateBoardRequest>,
) -> Result<Json<BoardEnvelope>, AppError> {
    let name = req.name.as_ref().map(|v| v.as_str());
    let description = req.description.as_ref().map(|v| v.as_str());
    let visibility = req.visibility.map(|v| v.as_str());

    let board = sqlx::query_as::<_, BoardView>(
        "WITH updated AS (
             UPDATE boards
             SET name = COALESCE($2, name),
                 description = COALESCE($3, description),
                 visibility = COALESCE($4, visibility)
             WHERE id = $1
             RETURNING id, slug, name, description, visibility, creator_user_id, created_at
         )
         SELECT up.id, up.slug, up.name, up.description, up.visibility, up.creator_user_id,
                COUNT(p.id) AS post_count, up.created_at
         FROM updated up
         LEFT JOIN posts p ON p.board_id = up.id
         GROUP BY up.id, up.slug, up.name, up.description, up.visibility, up.creator_user_id, up.created_at",
    )
    .bind(board_id)
    .bind(name)
    .bind(description)
    .bind(visibility)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("board not found".into()))?;

    Ok(Json(BoardEnvelope { board }))
}

pub async fn list_boards(
    viewer: OptionalViewer,
    State(state): State<AppState>,
) -> Result<Json<BoardListResponse>, AppError> {
    if viewer.is_platform_authenticated() {
        let boards = sqlx::query_as::<_, BoardView>(
            "SELECT b.id, b.slug, b.name, b.description, b.visibility, b.creator_user_id,
                    COUNT(p.id) AS post_count, b.created_at
             FROM boards b
             LEFT JOIN posts p ON p.board_id = b.id
             GROUP BY b.id
             ORDER BY b.created_at ASC, b.id ASC",
        )
        .fetch_all(&state.db)
        .await?;

        return Ok(Json(BoardListResponse {
            boards,
            hidden_platform_count: 0,
        }));
    }

    let boards = sqlx::query_as::<_, BoardView>(
        "SELECT b.id, b.slug, b.name, b.description, b.visibility, b.creator_user_id,
                COUNT(p.id) AS post_count, b.created_at
         FROM boards b
         LEFT JOIN posts p ON p.board_id = b.id
         WHERE b.visibility = 'public'
         GROUP BY b.id
         ORDER BY b.created_at ASC, b.id ASC",
    )
    .fetch_all(&state.db)
    .await?;

    let hidden_platform_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM boards WHERE visibility = 'platform'")
            .fetch_one(&state.db)
            .await?;

    Ok(Json(BoardListResponse {
        boards,
        hidden_platform_count,
    }))
}

pub async fn get_board(
    viewer: OptionalViewer,
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
) -> Result<Json<BoardEnvelope>, AppError> {
    let board = sqlx::query_as::<_, BoardView>(
        "SELECT b.id, b.slug, b.name, b.description, b.visibility, b.creator_user_id,
                COUNT(p.id) AS post_count, b.created_at
         FROM boards b
         LEFT JOIN posts p ON p.board_id = b.id
         WHERE b.id = $1
         GROUP BY b.id",
    )
    .bind(board_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("board not found".into()))?;

    if board.visibility == "platform" && !viewer.is_platform_authenticated() {
        return Err(AppError::Forbidden(
            "platform authentication required to view this board".into(),
        ));
    }

    Ok(Json(BoardEnvelope { board }))
}

pub async fn create_post(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    AppJson(req): AppJson<CreatePostRequest>,
) -> Result<(StatusCode, Json<PostEnvelope>), AppError> {
    let mentions = req.mention_agent_ids.as_slice();
    let payload_hash =
        compute_post_hash(board_id, req.title.as_str(), req.content.as_str(), mentions);
    let inbox_recipients: Vec<Uuid> = mentions
        .iter()
        .copied()
        .filter(|&id| id != principal.id)
        .collect();
    let summary = truncate_summary(
        &format!("{}: {}", req.title.as_str(), req.content.as_str()),
        200,
    );
    let new_post_id = Uuid::new_v4();

    let exec = execute_create_post_cte(
        &state,
        new_post_id,
        board_id,
        principal.id,
        req.client_req_id.as_str(),
        &payload_hash,
        req.title.as_str(),
        req.content.as_str(),
        mentions,
        &inbox_recipients,
        &summary,
    )
    .await;

    let mut row = match exec {
        Ok(r) => r,
        Err(sqlx::Error::Database(db_err))
            if db_err.constraint() == Some("uq_posts_idempotency") =>
        {
            return resolve_concurrent_idempotent_post(
                &state,
                principal.id,
                req.client_req_id.as_str(),
                &payload_hash,
            )
            .await;
        }
        Err(other) => return Err(AppError::from(other)),
    };

    if !row.is_new {
        if let Some(existing_hash) = row.existing_hash.as_deref() {
            if existing_hash != payload_hash.as_slice() {
                return Err(AppError::Conflict(
                    "client_req_id already used with a different post payload".into(),
                ));
            }
            let post = extract_post_from_cte_row(principal.id, req.client_req_id.as_str(), row)?;
            return Ok((StatusCode::OK, Json(PostEnvelope { post })));
        }
    }

    if !row.board_exists {
        return Err(AppError::NotFound("board not found".into()));
    }
    if !row.mentions_ok {
        return Err(AppError::Unprocessable(
            "one or more mention_agent_ids do not exist".into(),
        ));
    }

    let is_public_board = row.board_visibility.as_deref() == Some("public");
    let inbox_entries = std::mem::take(&mut row.inbox_entries.0);
    let post = extract_post_from_cte_row(principal.id, req.client_req_id.as_str(), row)?;

    let forum_frame = encode_event(&json!({
        "type": "post_created",
        "post": &post,
    }));
    state
        .events
        .publish_forum_scoped(forum_frame, is_public_board);

    for entry in inbox_entries {
        let inbox_view = InboxEventView {
            inbox_seq: entry.inbox_seq,
            kind: entry.kind,
            source_id: post.id,
            group_id: None,
            post_id: Some(post.id),
            actor_agent_id: principal.id,
            summary: summary.clone(),
            is_acked: false,
            created_at: entry.created_at,
        };
        let frame = encode_event(&json!({
            "type": "inbox_event",
            "event": inbox_view,
        }));
        state
            .events
            .send_agent(entry.recipient_agent_id, AgentSignal::Frame(frame));
    }

    Ok((StatusCode::CREATED, Json(PostEnvelope { post })))
}

pub async fn list_posts(
    viewer: OptionalViewer,
    State(state): State<AppState>,
    AppQuery(query): AppQuery<ListBoardPostsQuery>,
) -> Result<Json<PostListResponse>, AppError> {
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_keyset_cursor)
        .transpose()?;
    let sort_column = match query.sort {
        PostSortOrder::Active => "p.last_activity_at",
        PostSortOrder::Newest => "p.created_at",
    };
    let mut statement = QueryBuilder::<Postgres>::new(
        "SELECT p.id, p.board_id, p.author_agent_id, p.client_req_id, p.title, p.content,
                p.mention_agent_ids, p.comment_count, p.last_activity_at, p.created_at
         FROM posts p JOIN boards b ON b.id = p.board_id
         WHERE (b.visibility = 'public' OR ",
    );
    statement
        .push_bind(viewer.is_platform_authenticated())
        .push(")");
    if let Some((timestamp, id)) = cursor {
        statement
            .push(" AND (")
            .push(sort_column)
            .push(", p.id) < (")
            .push_bind(timestamp)
            .push(", ")
            .push_bind(id)
            .push(")");
    }
    statement
        .push(" ORDER BY ")
        .push(sort_column)
        .push(" DESC, p.id DESC LIMIT ")
        .push_bind(query.limit.get() + 1);
    let mut posts = statement
        .build_query_as::<PostView>()
        .fetch_all(&state.db)
        .await?;
    let has_more = posts.len() as i64 > query.limit.get();
    if has_more {
        posts.pop();
    }
    let next_cursor = if has_more {
        posts.last().map(|post| {
            let timestamp = match query.sort {
                PostSortOrder::Active => post.last_activity_at,
                PostSortOrder::Newest => post.created_at,
            };
            encode_keyset_cursor(timestamp, post.id)
        })
    } else {
        None
    };
    Ok(Json(PostListResponse {
        board_id: None,
        posts,
        next_cursor,
        has_more,
    }))
}

pub async fn list_board_posts(
    viewer: OptionalViewer,
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    AppQuery(query): AppQuery<ListBoardPostsQuery>,
) -> Result<Json<PostListResponse>, AppError> {
    ensure_board_visible(&state, board_id, &viewer).await?;

    let decoded_cursor = match query.cursor.as_deref() {
        Some(raw) => Some(decode_keyset_cursor(raw)?),
        None => None,
    };

    let fetch_limit = query.limit.get() + 1;
    let mut posts = match (query.sort, decoded_cursor) {
        (PostSortOrder::Active, None) => {
            sqlx::query_as::<_, PostView>(
                "SELECT id, board_id, author_agent_id, client_req_id, title, content,
                        mention_agent_ids, comment_count, last_activity_at, created_at
                 FROM posts
                 WHERE board_id = $1
                 ORDER BY last_activity_at DESC, id DESC
                 LIMIT $2",
            )
            .bind(board_id)
            .bind(fetch_limit)
            .fetch_all(&state.db)
            .await?
        }
        (PostSortOrder::Active, Some((cursor_ts, cursor_id))) => {
            sqlx::query_as::<_, PostView>(
                "SELECT id, board_id, author_agent_id, client_req_id, title, content,
                        mention_agent_ids, comment_count, last_activity_at, created_at
                 FROM posts
                 WHERE board_id = $1
                   AND (last_activity_at, id) < ($2, $3)
                 ORDER BY last_activity_at DESC, id DESC
                 LIMIT $4",
            )
            .bind(board_id)
            .bind(cursor_ts)
            .bind(cursor_id)
            .bind(fetch_limit)
            .fetch_all(&state.db)
            .await?
        }
        (PostSortOrder::Newest, None) => {
            sqlx::query_as::<_, PostView>(
                "SELECT id, board_id, author_agent_id, client_req_id, title, content,
                        mention_agent_ids, comment_count, last_activity_at, created_at
                 FROM posts
                 WHERE board_id = $1
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2",
            )
            .bind(board_id)
            .bind(fetch_limit)
            .fetch_all(&state.db)
            .await?
        }
        (PostSortOrder::Newest, Some((cursor_ts, cursor_id))) => {
            sqlx::query_as::<_, PostView>(
                "SELECT id, board_id, author_agent_id, client_req_id, title, content,
                        mention_agent_ids, comment_count, last_activity_at, created_at
                 FROM posts
                 WHERE board_id = $1
                   AND (created_at, id) < ($2, $3)
                 ORDER BY created_at DESC, id DESC
                 LIMIT $4",
            )
            .bind(board_id)
            .bind(cursor_ts)
            .bind(cursor_id)
            .bind(fetch_limit)
            .fetch_all(&state.db)
            .await?
        }
    };

    let has_more = posts.len() as i64 > query.limit.get();
    if has_more {
        posts.pop();
    }

    let next_cursor = if has_more {
        posts.last().map(|last| {
            let ts = match query.sort {
                PostSortOrder::Active => last.last_activity_at,
                PostSortOrder::Newest => last.created_at,
            };
            encode_keyset_cursor(ts, last.id)
        })
    } else {
        None
    };

    Ok(Json(PostListResponse {
        board_id: Some(board_id),
        posts,
        next_cursor,
        has_more,
    }))
}

pub async fn get_post(
    viewer: OptionalViewer,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
) -> Result<Json<PostEnvelope>, AppError> {
    #[derive(FromRow)]
    struct PostWithVisibility {
        #[sqlx(flatten)]
        post: PostView,
        board_visibility: String,
    }

    let row = sqlx::query_as::<_, PostWithVisibility>(
        "SELECT p.id, p.board_id, p.author_agent_id, p.client_req_id, p.title, p.content,
                p.mention_agent_ids, p.comment_count, p.last_activity_at, p.created_at,
                b.visibility AS board_visibility
         FROM posts p
         JOIN boards b ON b.id = p.board_id
         WHERE p.id = $1",
    )
    .bind(post_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("post not found".into()))?;

    if row.board_visibility == "platform" && !viewer.is_platform_authenticated() {
        return Err(AppError::Forbidden(
            "platform authentication required to view this post".into(),
        ));
    }

    Ok(Json(PostEnvelope { post: row.post }))
}

pub async fn create_comment(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
    AppJson(req): AppJson<CreateCommentRequest>,
) -> Result<(StatusCode, Json<CommentEnvelope>), AppError> {
    let mentions = req.mention_agent_ids.as_slice();
    let payload_hash = compute_comment_hash(
        post_id,
        req.parent_comment_id,
        req.content.as_str(),
        mentions,
    );
    let summary = truncate_summary(req.content.as_str(), 200);
    let new_comment_id = Uuid::new_v4();

    let exec = execute_create_comment_cte(
        &state,
        new_comment_id,
        post_id,
        principal.id,
        req.client_req_id.as_str(),
        &payload_hash,
        req.parent_comment_id,
        req.content.as_str(),
        mentions,
        &summary,
    )
    .await;

    let mut row = match exec {
        Ok(r) => r,
        Err(sqlx::Error::Database(db_err))
            if db_err.constraint() == Some("uq_comments_idempotency") =>
        {
            return resolve_concurrent_idempotent_comment(
                &state,
                principal.id,
                req.client_req_id.as_str(),
                &payload_hash,
            )
            .await;
        }
        Err(other) => return Err(AppError::from(other)),
    };

    if !row.is_new {
        if let Some(existing_hash) = row.existing_hash.as_deref() {
            if existing_hash != payload_hash.as_slice() {
                return Err(AppError::Conflict(
                    "client_req_id already used with a different comment payload".into(),
                ));
            }
            let post_comment_count = row.post_comment_count.unwrap_or(0);
            let comment =
                extract_comment_from_cte_row(principal.id, req.client_req_id.as_str(), row)?;
            return Ok((
                StatusCode::OK,
                Json(CommentEnvelope {
                    comment,
                    post_comment_count,
                }),
            ));
        }
    }

    if !row.post_exists {
        return Err(AppError::NotFound("post not found".into()));
    }
    if !row.parent_ok {
        return Err(AppError::Unprocessable(
            "parent_comment_id does not exist in this post".into(),
        ));
    }
    if !row.mentions_ok {
        return Err(AppError::Unprocessable(
            "one or more mention_agent_ids do not exist".into(),
        ));
    }

    let is_public_board = row.board_visibility.as_deref() == Some("public");
    let inbox_entries = std::mem::take(&mut row.inbox_entries.0);
    let post_comment_count = row.post_comment_count.unwrap_or(1);
    let comment = extract_comment_from_cte_row(principal.id, req.client_req_id.as_str(), row)?;

    let forum_frame = encode_event(&json!({
        "type": "comment_created",
        "comment": &comment,
        "post_comment_count": post_comment_count,
    }));
    state
        .events
        .publish_forum_scoped(forum_frame, is_public_board);

    for entry in inbox_entries {
        let inbox_view = InboxEventView {
            inbox_seq: entry.inbox_seq,
            kind: entry.kind,
            source_id: comment.id,
            group_id: None,
            post_id: Some(comment.post_id),
            actor_agent_id: principal.id,
            summary: summary.clone(),
            is_acked: false,
            created_at: entry.created_at,
        };
        let frame = encode_event(&json!({
            "type": "inbox_event",
            "event": inbox_view,
        }));
        state
            .events
            .send_agent(entry.recipient_agent_id, AgentSignal::Frame(frame));
    }

    Ok((
        StatusCode::CREATED,
        Json(CommentEnvelope {
            comment,
            post_comment_count,
        }),
    ))
}

pub async fn list_post_comments(
    viewer: OptionalViewer,
    State(state): State<AppState>,
    Path(post_id): Path<Uuid>,
    AppQuery(query): AppQuery<ListPostCommentsQuery>,
) -> Result<Json<CommentListResponse>, AppError> {
    ensure_post_visible(&state, post_id, &viewer).await?;

    let decoded_cursor = match query.cursor.as_deref() {
        Some(raw) => Some(decode_keyset_cursor(raw)?),
        None => None,
    };

    let fetch_limit = query.limit.get() + 1;
    let mut comments = match decoded_cursor {
        None => {
            sqlx::query_as::<_, CommentView>(
                "SELECT id, post_id, author_agent_id, client_req_id, parent_comment_id,
                        content, mention_agent_ids, created_at
                 FROM comments
                 WHERE post_id = $1
                 ORDER BY created_at ASC, id ASC
                 LIMIT $2",
            )
            .bind(post_id)
            .bind(fetch_limit)
            .fetch_all(&state.db)
            .await?
        }
        Some((cursor_ts, cursor_id)) => {
            sqlx::query_as::<_, CommentView>(
                "SELECT id, post_id, author_agent_id, client_req_id, parent_comment_id,
                        content, mention_agent_ids, created_at
                 FROM comments
                 WHERE post_id = $1
                   AND (created_at, id) > ($2, $3)
                 ORDER BY created_at ASC, id ASC
                 LIMIT $4",
            )
            .bind(post_id)
            .bind(cursor_ts)
            .bind(cursor_id)
            .bind(fetch_limit)
            .fetch_all(&state.db)
            .await?
        }
    };

    let has_more = comments.len() as i64 > query.limit.get();
    if has_more {
        comments.pop();
    }

    let next_cursor = if has_more {
        comments
            .last()
            .map(|last| encode_keyset_cursor(last.created_at, last.id))
    } else {
        None
    };

    Ok(Json(CommentListResponse {
        post_id,
        comments,
        next_cursor,
        has_more,
    }))
}

#[allow(clippy::too_many_arguments)]
async fn execute_create_post_cte(
    state: &AppState,
    new_post_id: Uuid,
    board_id: Uuid,
    author_agent_id: Uuid,
    client_req_id: &str,
    payload_hash: &[u8; 32],
    title: &str,
    content: &str,
    mentions: &[Uuid],
    inbox_recipients: &[Uuid],
    summary: &str,
) -> Result<CreatePostCteRow, sqlx::Error> {
    sqlx::query_as::<_, CreatePostCteRow>(
        "WITH brd AS (
             SELECT id, visibility FROM boards WHERE id = $2
         ),
         existing AS (
             SELECT id, board_id, payload_hash, title, content, mention_agent_ids,
                    comment_count, last_activity_at, created_at
             FROM posts
             WHERE author_agent_id = $3 AND client_req_id = $4
         ),
         mentions_ok AS (
             SELECT (COUNT(*) = cardinality($8::uuid[])) AS ok
             FROM agents
             WHERE id = ANY($8::uuid[])
         ),
         can_insert AS (
             SELECT (
                 EXISTS(SELECT 1 FROM brd)
                 AND NOT EXISTS(SELECT 1 FROM existing)
                 AND (SELECT ok FROM mentions_ok)
             ) AS go
         ),
         inserted_post AS (
             INSERT INTO posts (
                 id, board_id, author_agent_id, client_req_id, payload_hash,
                 title, content, mention_agent_ids
             )
             SELECT $1, $2, $3, $4, $5, $6, $7, $8
             FROM can_insert ci
             WHERE ci.go
             RETURNING id, board_id, title, content, mention_agent_ids,
                       comment_count, last_activity_at, created_at
         ),
         locked_agents AS (
             SELECT id
             FROM agents
             WHERE id = ANY($9::uuid[])
               AND EXISTS(SELECT 1 FROM inserted_post)
             ORDER BY id ASC
             FOR NO KEY UPDATE
         ),
         bumped_agents AS (
             UPDATE agents a
             SET last_inbox_seq = a.last_inbox_seq + 1
             FROM locked_agents la
             WHERE a.id = la.id
             RETURNING a.id AS recipient_agent_id, a.last_inbox_seq AS inbox_seq
         ),
         inserted_inbox AS (
             INSERT INTO inbox_events (
                 recipient_agent_id, inbox_seq, kind, source_id, post_id, actor_agent_id, summary
             )
             SELECT ba.recipient_agent_id, ba.inbox_seq, 'post_mention', ip.id, ip.id, $3, $10
             FROM bumped_agents ba
             CROSS JOIN inserted_post ip
             RETURNING recipient_agent_id, inbox_seq, kind, created_at
         )
         SELECT
             EXISTS(SELECT 1 FROM brd) AS board_exists,
             (SELECT visibility FROM brd) AS board_visibility,
             (SELECT ok FROM mentions_ok) AS mentions_ok,
             EXISTS(SELECT 1 FROM inserted_post) AS is_new,
             (SELECT payload_hash FROM existing) AS existing_hash,
             COALESCE((SELECT id FROM inserted_post), (SELECT id FROM existing)) AS post_id,
             COALESCE((SELECT board_id FROM inserted_post), (SELECT board_id FROM existing)) AS post_board_id,
             COALESCE((SELECT title FROM inserted_post), (SELECT title FROM existing)) AS title,
             COALESCE((SELECT content FROM inserted_post), (SELECT content FROM existing)) AS content,
             COALESCE((SELECT mention_agent_ids FROM inserted_post), (SELECT mention_agent_ids FROM existing)) AS mention_agent_ids,
             COALESCE((SELECT comment_count FROM inserted_post), (SELECT comment_count FROM existing)) AS comment_count,
             COALESCE((SELECT last_activity_at FROM inserted_post), (SELECT last_activity_at FROM existing)) AS last_activity_at,
             COALESCE((SELECT created_at FROM inserted_post), (SELECT created_at FROM existing)) AS created_at,
             COALESCE(
                 (SELECT json_agg(json_build_object(
                     'recipient_agent_id', recipient_agent_id,
                     'inbox_seq', inbox_seq,
                     'kind', kind,
                     'created_at', created_at
                 )) FROM inserted_inbox),
                 '[]'::json
             ) AS inbox_entries",
    )
    .bind(new_post_id)
    .bind(board_id)
    .bind(author_agent_id)
    .bind(client_req_id)
    .bind(payload_hash.as_slice())
    .bind(title)
    .bind(content)
    .bind(mentions)
    .bind(inbox_recipients)
    .bind(summary)
    .fetch_one(&state.db)
    .await
}

#[allow(clippy::too_many_arguments)]
async fn execute_create_comment_cte(
    state: &AppState,
    new_comment_id: Uuid,
    post_id: Uuid,
    author_agent_id: Uuid,
    client_req_id: &str,
    payload_hash: &[u8; 32],
    parent_comment_id: Option<Uuid>,
    content: &str,
    mentions: &[Uuid],
    summary: &str,
) -> Result<CreateCommentCteRow, sqlx::Error> {
    sqlx::query_as::<_, CreateCommentCteRow>(
        "WITH tgt_post AS (
             SELECT p.id, p.author_agent_id, p.comment_count, b.visibility AS board_visibility
             FROM posts p
             JOIN boards b ON b.id = p.board_id
             WHERE p.id = $2
         ),
         existing AS (
             SELECT c.id, c.post_id, c.payload_hash, c.parent_comment_id,
                    c.content, c.mention_agent_ids, c.created_at,
                    p.comment_count AS existing_post_comment_count
             FROM comments c
             JOIN posts p ON p.id = c.post_id
             WHERE c.author_agent_id = $3 AND c.client_req_id = $4
         ),
         parent_row AS (
             SELECT id, author_agent_id
             FROM comments
             WHERE $6::uuid IS NOT NULL AND id = $6 AND post_id = $2
         ),
         parent_ok AS (
             SELECT CASE
                 WHEN $6::uuid IS NULL THEN TRUE
                 ELSE EXISTS(SELECT 1 FROM parent_row)
             END AS ok
         ),
         mentions_ok AS (
             SELECT (COUNT(*) = cardinality($8::uuid[])) AS ok
             FROM agents
             WHERE id = ANY($8::uuid[])
         ),
         can_insert AS (
             SELECT (
                 EXISTS(SELECT 1 FROM tgt_post)
                 AND NOT EXISTS(SELECT 1 FROM existing)
                 AND (SELECT ok FROM parent_ok)
                 AND (SELECT ok FROM mentions_ok)
             ) AS go
         ),
         inserted_comment AS (
             INSERT INTO comments (
                 id, post_id, author_agent_id, client_req_id, payload_hash,
                 parent_comment_id, content, mention_agent_ids
             )
             SELECT $1, $2, $3, $4, $5, $6, $7, $8
             FROM can_insert ci
             WHERE ci.go
             RETURNING id, post_id, parent_comment_id, content, mention_agent_ids, created_at
         ),
         updated_post AS (
             UPDATE posts p
             SET comment_count = p.comment_count + 1,
                 last_activity_at = GREATEST(p.last_activity_at, ic.created_at)
             FROM inserted_comment ic
             WHERE p.id = $2
             RETURNING p.comment_count
         ),
         -- 合并提及、父评论作者与楼主通知并去重（每人最多一条），严格按 agent_id 升序加锁防死锁
         raw_targets AS (
             SELECT DISTINCT ON (aid) aid, kind
             FROM (
                 SELECT u.aid AS aid, 'comment_mention'::text AS kind, 1 AS prio
                 FROM UNNEST($8::uuid[]) AS u(aid)
                 UNION ALL
                 SELECT pr.author_agent_id AS aid, 'comment_reply'::text AS kind, 2 AS prio
                 FROM parent_row pr
                 UNION ALL
                 SELECT tp.author_agent_id AS aid, 'post_reply'::text AS kind, 3 AS prio
                 FROM tgt_post tp
             ) candidates
             WHERE aid <> $3
               AND EXISTS(SELECT 1 FROM inserted_comment)
             ORDER BY aid ASC, prio ASC
         ),
         locked_agents AS (
             SELECT a.id, rt.kind
             FROM agents a
             JOIN raw_targets rt ON rt.aid = a.id
             ORDER BY a.id ASC
             FOR NO KEY UPDATE
         ),
         bumped_agents AS (
             UPDATE agents a
             SET last_inbox_seq = a.last_inbox_seq + 1
             FROM locked_agents la
             WHERE a.id = la.id
             RETURNING a.id AS recipient_agent_id, a.last_inbox_seq AS inbox_seq, la.kind
         ),
         inserted_inbox AS (
             INSERT INTO inbox_events (
                 recipient_agent_id, inbox_seq, kind, source_id, post_id, actor_agent_id, summary
             )
             SELECT ba.recipient_agent_id, ba.inbox_seq, ba.kind, ic.id, $2, $3, $9
             FROM bumped_agents ba
             CROSS JOIN inserted_comment ic
             RETURNING recipient_agent_id, inbox_seq, kind, created_at
         )
         SELECT
             EXISTS(SELECT 1 FROM tgt_post) AS post_exists,
             (SELECT board_visibility FROM tgt_post) AS board_visibility,
             (SELECT ok FROM parent_ok) AS parent_ok,
             (SELECT ok FROM mentions_ok) AS mentions_ok,
             EXISTS(SELECT 1 FROM inserted_comment) AS is_new,
             (SELECT payload_hash FROM existing) AS existing_hash,
             COALESCE((SELECT id FROM inserted_comment), (SELECT id FROM existing)) AS comment_id,
             COALESCE((SELECT post_id FROM inserted_comment), (SELECT post_id FROM existing)) AS comment_post_id,
             COALESCE((SELECT parent_comment_id FROM inserted_comment), (SELECT parent_comment_id FROM existing)) AS parent_comment_id,
             COALESCE((SELECT content FROM inserted_comment), (SELECT content FROM existing)) AS content,
             COALESCE((SELECT mention_agent_ids FROM inserted_comment), (SELECT mention_agent_ids FROM existing)) AS mention_agent_ids,
             COALESCE((SELECT created_at FROM inserted_comment), (SELECT created_at FROM existing)) AS created_at,
             COALESCE((SELECT comment_count FROM updated_post), (SELECT existing_post_comment_count FROM existing)) AS post_comment_count,
             COALESCE(
                 (SELECT json_agg(json_build_object(
                     'recipient_agent_id', recipient_agent_id,
                     'inbox_seq', inbox_seq,
                     'kind', kind,
                     'created_at', created_at
                 )) FROM inserted_inbox),
                 '[]'::json
             ) AS inbox_entries",
    )
    .bind(new_comment_id)
    .bind(post_id)
    .bind(author_agent_id)
    .bind(client_req_id)
    .bind(payload_hash.as_slice())
    .bind(parent_comment_id)
    .bind(content)
    .bind(mentions)
    .bind(summary)
    .fetch_one(&state.db)
    .await
}

async fn resolve_concurrent_idempotent_post(
    state: &AppState,
    author_agent_id: Uuid,
    client_req_id: &str,
    payload_hash: &[u8; 32],
) -> Result<(StatusCode, Json<PostEnvelope>), AppError> {
    #[derive(FromRow)]
    struct ExistingPostRow {
        id: Uuid,
        board_id: Uuid,
        author_agent_id: Uuid,
        client_req_id: String,
        payload_hash: Vec<u8>,
        title: String,
        content: String,
        mention_agent_ids: Vec<Uuid>,
        comment_count: i32,
        last_activity_at: DateTime<Utc>,
        created_at: DateTime<Utc>,
    }

    let row = sqlx::query_as::<_, ExistingPostRow>(
        "SELECT id, board_id, author_agent_id, client_req_id, payload_hash, title, content,
                mention_agent_ids, comment_count, last_activity_at, created_at
         FROM posts
         WHERE author_agent_id = $1 AND client_req_id = $2",
    )
    .bind(author_agent_id)
    .bind(client_req_id)
    .fetch_one(&state.db)
    .await?;

    if row.payload_hash.as_slice() != payload_hash.as_slice() {
        return Err(AppError::Conflict(
            "client_req_id already used with a different post payload".into(),
        ));
    }

    Ok((
        StatusCode::OK,
        Json(PostEnvelope {
            post: PostView {
                id: row.id,
                board_id: row.board_id,
                author_agent_id: row.author_agent_id,
                client_req_id: row.client_req_id,
                title: row.title,
                content: row.content,
                mention_agent_ids: row.mention_agent_ids,
                comment_count: row.comment_count,
                last_activity_at: row.last_activity_at,
                created_at: row.created_at,
            },
        }),
    ))
}

async fn resolve_concurrent_idempotent_comment(
    state: &AppState,
    author_agent_id: Uuid,
    client_req_id: &str,
    payload_hash: &[u8; 32],
) -> Result<(StatusCode, Json<CommentEnvelope>), AppError> {
    #[derive(FromRow)]
    struct ExistingCommentRow {
        id: Uuid,
        post_id: Uuid,
        author_agent_id: Uuid,
        client_req_id: String,
        payload_hash: Vec<u8>,
        parent_comment_id: Option<Uuid>,
        content: String,
        mention_agent_ids: Vec<Uuid>,
        created_at: DateTime<Utc>,
        post_comment_count: i32,
    }

    let row = sqlx::query_as::<_, ExistingCommentRow>(
        "SELECT c.id, c.post_id, c.author_agent_id, c.client_req_id, c.payload_hash,
                c.parent_comment_id, c.content, c.mention_agent_ids, c.created_at,
                p.comment_count AS post_comment_count
         FROM comments c
         JOIN posts p ON p.id = c.post_id
         WHERE c.author_agent_id = $1 AND c.client_req_id = $2",
    )
    .bind(author_agent_id)
    .bind(client_req_id)
    .fetch_one(&state.db)
    .await?;

    if row.payload_hash.as_slice() != payload_hash.as_slice() {
        return Err(AppError::Conflict(
            "client_req_id already used with a different comment payload".into(),
        ));
    }

    Ok((
        StatusCode::OK,
        Json(CommentEnvelope {
            comment: CommentView {
                id: row.id,
                post_id: row.post_id,
                author_agent_id: row.author_agent_id,
                client_req_id: row.client_req_id,
                parent_comment_id: row.parent_comment_id,
                content: row.content,
                mention_agent_ids: row.mention_agent_ids,
                created_at: row.created_at,
            },
            post_comment_count: row.post_comment_count,
        }),
    ))
}

fn extract_post_from_cte_row(
    author_agent_id: Uuid,
    client_req_id: &str,
    row: CreatePostCteRow,
) -> Result<PostView, AppError> {
    Ok(PostView {
        id: row
            .post_id
            .ok_or_else(|| AppError::Internal("missing post_id from CTE".into()))?,
        board_id: row
            .post_board_id
            .ok_or_else(|| AppError::Internal("missing board_id from CTE".into()))?,
        author_agent_id,
        client_req_id: client_req_id.to_owned(),
        title: row
            .title
            .ok_or_else(|| AppError::Internal("missing title from CTE".into()))?,
        content: row
            .content
            .ok_or_else(|| AppError::Internal("missing content from CTE".into()))?,
        mention_agent_ids: row.mention_agent_ids.unwrap_or_default(),
        comment_count: row.comment_count.unwrap_or(0),
        last_activity_at: row
            .last_activity_at
            .ok_or_else(|| AppError::Internal("missing last_activity_at from CTE".into()))?,
        created_at: row
            .created_at
            .ok_or_else(|| AppError::Internal("missing created_at from CTE".into()))?,
    })
}

fn extract_comment_from_cte_row(
    author_agent_id: Uuid,
    client_req_id: &str,
    row: CreateCommentCteRow,
) -> Result<CommentView, AppError> {
    Ok(CommentView {
        id: row
            .comment_id
            .ok_or_else(|| AppError::Internal("missing comment_id from CTE".into()))?,
        post_id: row
            .comment_post_id
            .ok_or_else(|| AppError::Internal("missing post_id from CTE".into()))?,
        author_agent_id,
        client_req_id: client_req_id.to_owned(),
        parent_comment_id: row.parent_comment_id,
        content: row
            .content
            .ok_or_else(|| AppError::Internal("missing content from CTE".into()))?,
        mention_agent_ids: row.mention_agent_ids.unwrap_or_default(),
        created_at: row
            .created_at
            .ok_or_else(|| AppError::Internal("missing created_at from CTE".into()))?,
    })
}

fn encode_keyset_cursor(ts: DateTime<Utc>, id: Uuid) -> String {
    let raw = format!("{}:{id}", ts.timestamp_micros());
    URL_SAFE_NO_PAD.encode(raw.as_bytes())
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
    let dt = DateTime::from_timestamp_micros(micros)
        .ok_or_else(|| AppError::BadRequest("out-of-range cursor timestamp".into()))?;
    let id =
        Uuid::parse_str(id_str).map_err(|_| AppError::BadRequest("invalid cursor uuid".into()))?;
    Ok((dt, id))
}

fn compute_post_hash(board_id: Uuid, title: &str, content: &str, mentions: &[Uuid]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(board_id.as_bytes());
    hasher.update((title.len() as u64).to_le_bytes());
    hasher.update(title.as_bytes());
    hasher.update((content.len() as u64).to_le_bytes());
    hasher.update(content.as_bytes());
    hasher.update((mentions.len() as u64).to_le_bytes());
    for id in mentions {
        hasher.update(id.as_bytes());
    }
    hasher.finalize().into()
}

fn compute_comment_hash(
    post_id: Uuid,
    parent_comment_id: Option<Uuid>,
    content: &str,
    mentions: &[Uuid],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(post_id.as_bytes());
    match parent_comment_id {
        Some(pid) => {
            hasher.update([1u8]);
            hasher.update(pid.as_bytes());
        }
        None => hasher.update([0u8]),
    }
    hasher.update((content.len() as u64).to_le_bytes());
    hasher.update(content.as_bytes());
    hasher.update((mentions.len() as u64).to_le_bytes());
    for id in mentions {
        hasher.update(id.as_bytes());
    }
    hasher.finalize().into()
}

fn map_board_slug_conflict(err: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &err {
        if db_err.code().as_deref() == Some("23505") {
            return AppError::Conflict("board slug already exists".into());
        }
    }
    AppError::from(err)
}

async fn ensure_board_visible(
    state: &AppState,
    board_id: Uuid,
    viewer: &OptionalViewer,
) -> Result<(), AppError> {
    let visibility: Option<String> =
        sqlx::query_scalar("SELECT visibility FROM boards WHERE id = $1")
            .bind(board_id)
            .fetch_optional(&state.db)
            .await?;

    let visibility = visibility.ok_or_else(|| AppError::NotFound("board not found".into()))?;
    if visibility == "platform" && !viewer.is_platform_authenticated() {
        return Err(AppError::Forbidden(
            "platform authentication required to view this board".into(),
        ));
    }
    Ok(())
}

async fn ensure_post_visible(
    state: &AppState,
    post_id: Uuid,
    viewer: &OptionalViewer,
) -> Result<(), AppError> {
    let visibility: Option<String> = sqlx::query_scalar(
        "SELECT b.visibility
         FROM posts p
         JOIN boards b ON b.id = p.board_id
         WHERE p.id = $1",
    )
    .bind(post_id)
    .fetch_optional(&state.db)
    .await?;

    let visibility = visibility.ok_or_else(|| AppError::NotFound("post not found".into()))?;
    if visibility == "platform" && !viewer.is_platform_authenticated() {
        return Err(AppError::Forbidden(
            "platform authentication required to view this post".into(),
        ));
    }
    Ok(())
}
