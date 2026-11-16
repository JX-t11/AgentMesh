use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::types::Json as SqlxJson;
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{AdminAuth, AgentAuth};
use crate::domain::types::{
    ClientReqId, DescriptionText, MessageBody, PageLimit, ShortName, Slug, UniqueAgentIds,
};
use crate::error::{AppError, AppJson, AppQuery};
use crate::events::{encode_event, AgentSignal};
use crate::routes::inbox::InboxEventView;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct CreateGroupRequest {
    pub slug: Slug,
    pub name: ShortName,
    #[serde(default)]
    pub description: DescriptionText,
    #[serde(default)]
    pub member_agent_ids: UniqueAgentIds,
}

#[derive(Deserialize)]
pub struct AddGroupMembersRequest {
    pub agent_id: Option<Uuid>,
    #[serde(default)]
    pub agent_ids: UniqueAgentIds,
}

#[derive(Deserialize)]
pub struct PostGroupMessageRequest {
    pub client_msg_id: ClientReqId,
    pub content: MessageBody,
    pub reply_to_msg_id: Option<Uuid>,
    #[serde(default)]
    pub mention_agent_ids: UniqueAgentIds,
}

#[derive(Deserialize)]
pub struct ListGroupMessagesQuery {
    pub after_seq: Option<i64>,
    pub before_seq: Option<i64>,
    #[serde(default)]
    pub limit: PageLimit,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct GroupView {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub last_seq: i64,
    pub member_count: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct GroupMemberView {
    pub agent_id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub framework: String,
    pub joined_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct GroupMessageView {
    pub id: Uuid,
    pub group_id: Uuid,
    pub seq: i64,
    pub sender_agent_id: Uuid,
    pub client_msg_id: String,
    pub content: String,
    pub reply_to_msg_id: Option<Uuid>,
    pub mention_agent_ids: Vec<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct GroupEnvelope {
    pub group: GroupView,
}

#[derive(Serialize)]
pub struct GroupListResponse {
    pub groups: Vec<GroupView>,
}

#[derive(Serialize)]
pub struct GroupMembersResponse {
    pub group_id: Uuid,
    pub members: Vec<GroupMemberView>,
}

#[derive(Serialize)]
pub struct GroupMessageEnvelope {
    pub message: GroupMessageView,
}

#[derive(Serialize)]
pub struct GroupMessagesListResponse {
    pub group_id: Uuid,
    pub messages: Vec<GroupMessageView>,
    pub has_more: bool,
}

#[derive(Deserialize)]
struct CreatedInboxEntry {
    recipient_agent_id: Uuid,
    inbox_seq: i64,
    created_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct PostGroupMsgCteRow {
    group_exists: bool,
    member_ok: bool,
    mentions_ok: bool,
    reply_ok: bool,
    is_new: bool,
    existing_hash: Option<Vec<u8>>,
    msg_id: Option<Uuid>,
    seq: Option<i64>,
    content: Option<String>,
    reply_to_msg_id: Option<Uuid>,
    mention_agent_ids: Option<Vec<Uuid>>,
    created_at: Option<DateTime<Utc>>,
    inbox_entries: SqlxJson<Vec<CreatedInboxEntry>>,
}

pub async fn create_group(
    _admin: AdminAuth,
    State(state): State<AppState>,
    AppJson(req): AppJson<CreateGroupRequest>,
) -> Result<(StatusCode, Json<GroupEnvelope>), AppError> {
    let group_id = Uuid::new_v4();
    let initial_members = req.member_agent_ids.as_slice();

    let row: Option<(bool, Option<Uuid>)> = sqlx::query_as(
        "WITH valid_agents AS (
             SELECT COUNT(*) = cardinality($5::uuid[]) AS all_exist
             FROM agents
             WHERE id = ANY($5::uuid[])
         ),
         ins_group AS (
             INSERT INTO groups (id, slug, name, description)
             SELECT $1, $2, $3, $4
             FROM valid_agents
             WHERE all_exist
             RETURNING id
         ),
         ins_members AS (
             INSERT INTO group_members (group_id, agent_id)
             SELECT g.id, UNNEST($5::uuid[])
             FROM ins_group g
         )
         SELECT va.all_exist, (SELECT id FROM ins_group)
         FROM valid_agents va",
    )
    .bind(group_id)
    .bind(req.slug.as_str())
    .bind(req.name.as_str())
    .bind(req.description.as_str())
    .bind(initial_members)
    .fetch_optional(&state.db)
    .await
    .map_err(map_group_slug_conflict)?;

    let (all_exist, created_id) = row.unwrap_or((false, None));
    if !all_exist || created_id.is_none() {
        return Err(AppError::Unprocessable(
            "one or more member_agent_ids do not exist".into(),
        ));
    }

    notify_members_joined(&state, group_id, req.slug.as_str(), initial_members);
    let group = fetch_group_view(&state, group_id).await?;
    Ok((StatusCode::CREATED, Json(GroupEnvelope { group })))
}

pub async fn add_group_members(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path(group_id): Path<Uuid>,
    AppJson(req): AppJson<AddGroupMembersRequest>,
) -> Result<Json<GroupMembersResponse>, AppError> {
    let target_ids = collect_requested_member_ids(req)?;

    let outcome: (bool, bool, Vec<Uuid>) = sqlx::query_as(
        "WITH grp AS (
             SELECT id, slug FROM groups WHERE id = $1
         ),
         valid_agents AS (
             SELECT COUNT(*) = cardinality($2::uuid[]) AS all_exist
             FROM agents
             WHERE id = ANY($2::uuid[])
         ),
         ins AS (
             INSERT INTO group_members (group_id, agent_id)
             SELECT g.id, u.aid
             FROM grp g
             CROSS JOIN valid_agents va
             CROSS JOIN UNNEST($2::uuid[]) AS u(aid)
             WHERE va.all_exist
             ON CONFLICT (group_id, agent_id) DO NOTHING
             RETURNING agent_id
         )
         SELECT
             EXISTS(SELECT 1 FROM grp) AS group_exists,
             (SELECT all_exist FROM valid_agents) AS agents_exist,
             COALESCE((SELECT array_agg(agent_id) FROM ins), '{}'::uuid[]) AS added_ids",
    )
    .bind(group_id)
    .bind(&target_ids)
    .fetch_one(&state.db)
    .await?;

    if !outcome.0 {
        return Err(AppError::NotFound("group not found".into()));
    }
    if !outcome.1 {
        return Err(AppError::Unprocessable(
            "one or more agent_ids do not exist".into(),
        ));
    }

    if !outcome.2.is_empty() {
        let group = fetch_group_view(&state, group_id).await?;
        notify_members_joined(&state, group_id, &group.slug, &outcome.2);
    }

    let members = fetch_group_members(&state, group_id).await?;
    Ok(Json(GroupMembersResponse { group_id, members }))
}

pub async fn remove_group_member(
    _admin: AdminAuth,
    State(state): State<AppState>,
    Path((group_id, agent_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, AppError> {
    let outcome: (bool, bool) = sqlx::query_as(
        "WITH grp AS (
             SELECT id FROM groups WHERE id = $1
         ),
         del AS (
             DELETE FROM group_members
             WHERE group_id = $1 AND agent_id = $2
             RETURNING agent_id
         )
         SELECT EXISTS(SELECT 1 FROM grp), EXISTS(SELECT 1 FROM del)",
    )
    .bind(group_id)
    .bind(agent_id)
    .fetch_one(&state.db)
    .await?;

    if !outcome.0 {
        return Err(AppError::NotFound("group not found".into()));
    }
    if outcome.1 {
        let frame = encode_event(&json!({
            "type": "group_left",
            "group_id": group_id,
            "agent_id": agent_id,
        }));
        state
            .events
            .send_agent(agent_id, AgentSignal::LeaveGroup { group_id, frame });
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_groups(State(state): State<AppState>) -> Result<Json<GroupListResponse>, AppError> {
    let groups = sqlx::query_as::<_, GroupView>(
        "SELECT g.id, g.slug, g.name, g.description, g.last_seq,
                COUNT(gm.agent_id) AS member_count, g.created_at
         FROM groups g
         LEFT JOIN group_members gm ON gm.group_id = g.id
         GROUP BY g.id
         ORDER BY g.created_at ASC, g.id ASC",
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(GroupListResponse { groups }))
}

pub async fn get_group(
    State(state): State<AppState>,
    Path(group_id): Path<Uuid>,
) -> Result<Json<GroupEnvelope>, AppError> {
    let group = fetch_group_view(&state, group_id).await?;
    Ok(Json(GroupEnvelope { group }))
}

pub async fn list_group_members(
    State(state): State<AppState>,
    Path(group_id): Path<Uuid>,
) -> Result<Json<GroupMembersResponse>, AppError> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM groups WHERE id = $1)")
        .bind(group_id)
        .fetch_one(&state.db)
        .await?;
    if !exists {
        return Err(AppError::NotFound("group not found".into()));
    }

    let members = fetch_group_members(&state, group_id).await?;
    Ok(Json(GroupMembersResponse { group_id, members }))
}

pub async fn post_group_message(
    AgentAuth(principal): AgentAuth,
    State(state): State<AppState>,
    Path(group_id): Path<Uuid>,
    AppJson(req): AppJson<PostGroupMessageRequest>,
) -> Result<(StatusCode, Json<GroupMessageEnvelope>), AppError> {
    let mentions = req.mention_agent_ids.as_slice();
    let payload_hash = compute_group_msg_hash(req.content.as_str(), req.reply_to_msg_id, mentions);
    let inbox_recipients: Vec<Uuid> = mentions
        .iter()
        .copied()
        .filter(|&id| id != principal.id)
        .collect();
    let summary = truncate_summary(req.content.as_str(), 200);
    let new_msg_id = Uuid::new_v4();

    let exec = execute_post_group_msg_cte(
        &state,
        new_msg_id,
        group_id,
        principal.id,
        req.client_msg_id.as_str(),
        &payload_hash,
        req.content.as_str(),
        req.reply_to_msg_id,
        mentions,
        &inbox_recipients,
        &summary,
    )
    .await;

    let mut row = match exec {
        Ok(r) => r,
        Err(sqlx::Error::Database(db_err))
            if db_err.constraint() == Some("uq_group_messages_idempotency") =>
        {
            // 微秒级并发同 client_msg_id 双发：语句已原子回滚（不消耗 seq），直接查已胜出的记录比对哈希。
            return resolve_concurrent_idempotent_group_msg(
                &state,
                group_id,
                principal.id,
                req.client_msg_id.as_str(),
                &payload_hash,
            )
            .await;
        }
        Err(other) => return Err(AppError::from(other)),
    };

    if !row.group_exists {
        return Err(AppError::NotFound("group not found".into()));
    }
    if !row.member_ok {
        return Err(AppError::Forbidden(
            "agent is not a member of this group".into(),
        ));
    }

    if !row.is_new {
        if let Some(existing_hash) = row.existing_hash.as_deref() {
            if existing_hash != payload_hash.as_slice() {
                return Err(AppError::Conflict(
                    "client_msg_id already used with a different message payload".into(),
                ));
            }
            let msg =
                extract_msg_from_cte_row(group_id, principal.id, req.client_msg_id.as_str(), row)?;
            return Ok((StatusCode::OK, Json(GroupMessageEnvelope { message: msg })));
        }
    }

    if !row.mentions_ok {
        return Err(AppError::Unprocessable(
            "all mention_agent_ids must be current members of the group".into(),
        ));
    }
    if !row.reply_ok {
        return Err(AppError::Unprocessable(
            "reply_to_msg_id does not exist in this group".into(),
        ));
    }

    let inbox_entries = std::mem::take(&mut row.inbox_entries.0);
    let message = extract_msg_from_cte_row(group_id, principal.id, req.client_msg_id.as_str(), row)?;

    let group_frame = encode_event(&json!({
        "type": "group_message",
        "message": &message,
    }));
    state.events.publish_group(group_id, group_frame);

    for entry in inbox_entries {
        let inbox_view = InboxEventView {
            inbox_seq: entry.inbox_seq,
            kind: "group_mention".into(),
            source_id: message.id,
            group_id: Some(group_id),
            post_id: None,
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

    Ok((StatusCode::CREATED, Json(GroupMessageEnvelope { message })))
}

pub async fn list_group_messages(
    State(state): State<AppState>,
    Path(group_id): Path<Uuid>,
    AppQuery(query): AppQuery<ListGroupMessagesQuery>,
) -> Result<Json<GroupMessagesListResponse>, AppError> {
    if query.after_seq.is_some() && query.before_seq.is_some() {
        return Err(AppError::BadRequest(
            "cannot specify both after_seq and before_seq".into(),
        ));
    }

    let fetch_limit = query.limit.get() + 1;
    let (mut messages, reverse_needed) = if let Some(after_seq) = query.after_seq {
        if after_seq < 0 {
            return Err(AppError::BadRequest("after_seq must be >= 0".into()));
        }
        let rows = sqlx::query_as::<_, GroupMessageView>(
            "SELECT id, group_id, seq, sender_agent_id, client_msg_id, content,
                    reply_to_msg_id, mention_agent_ids, created_at
             FROM group_messages
             WHERE group_id = $1 AND seq > $2
             ORDER BY seq ASC
             LIMIT $3",
        )
        .bind(group_id)
        .bind(after_seq)
        .bind(fetch_limit)
        .fetch_all(&state.db)
        .await?;
        (rows, false)
    } else if let Some(before_seq) = query.before_seq {
        if before_seq <= 0 {
            return Err(AppError::BadRequest("before_seq must be > 0".into()));
        }
        let rows = sqlx::query_as::<_, GroupMessageView>(
            "SELECT id, group_id, seq, sender_agent_id, client_msg_id, content,
                    reply_to_msg_id, mention_agent_ids, created_at
             FROM group_messages
             WHERE group_id = $1 AND seq < $2
             ORDER BY seq DESC
             LIMIT $3",
        )
        .bind(group_id)
        .bind(before_seq)
        .bind(fetch_limit)
        .fetch_all(&state.db)
        .await?;
        (rows, true)
    } else {
        let rows = sqlx::query_as::<_, GroupMessageView>(
            "SELECT id, group_id, seq, sender_agent_id, client_msg_id, content,
                    reply_to_msg_id, mention_agent_ids, created_at
             FROM group_messages
             WHERE group_id = $1
             ORDER BY seq DESC
             LIMIT $2",
        )
        .bind(group_id)
        .bind(fetch_limit)
        .fetch_all(&state.db)
        .await?;
        (rows, true)
    };

    if messages.is_empty() {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM groups WHERE id = $1)")
            .bind(group_id)
            .fetch_one(&state.db)
            .await?;
        if !exists {
            return Err(AppError::NotFound("group not found".into()));
        }
    }

    let has_more = messages.len() as i64 > query.limit.get();
    if has_more {
        messages.pop();
    }
    if reverse_needed {
        messages.reverse();
    }

    Ok(Json(GroupMessagesListResponse {
        group_id,
        messages,
        has_more,
    }))
}

#[allow(clippy::too_many_arguments)]
async fn execute_post_group_msg_cte(
    state: &AppState,
    new_msg_id: Uuid,
    group_id: Uuid,
    sender_agent_id: Uuid,
    client_msg_id: &str,
    payload_hash: &[u8; 32],
    content: &str,
    reply_to_msg_id: Option<Uuid>,
    mentions: &[Uuid],
    inbox_recipients: &[Uuid],
    summary: &str,
) -> Result<PostGroupMsgCteRow, sqlx::Error> {
    sqlx::query_as::<_, PostGroupMsgCteRow>(
        "WITH grp AS (
             SELECT id FROM groups WHERE id = $2
         ),
         member_ok AS (
             SELECT EXISTS(
                 SELECT 1 FROM group_members WHERE group_id = $2 AND agent_id = $3
             ) AS ok
         ),
         existing AS (
             SELECT id, seq, payload_hash, content, reply_to_msg_id, mention_agent_ids, created_at
             FROM group_messages
             WHERE group_id = $2 AND sender_agent_id = $3 AND client_msg_id = $4
         ),
         mentions_ok AS (
             SELECT (COUNT(*) = cardinality($8::uuid[])) AS ok
             FROM group_members
             WHERE group_id = $2 AND agent_id = ANY($8::uuid[])
         ),
         reply_ok AS (
             SELECT CASE
                 WHEN $7::uuid IS NULL THEN TRUE
                 ELSE EXISTS(SELECT 1 FROM group_messages WHERE id = $7 AND group_id = $2)
             END AS ok
         ),
         can_insert AS (
             SELECT (
                 EXISTS(SELECT 1 FROM grp)
                 AND (SELECT ok FROM member_ok)
                 AND NOT EXISTS(SELECT 1 FROM existing)
                 AND (SELECT ok FROM mentions_ok)
                 AND (SELECT ok FROM reply_ok)
             ) AS go
         ),
         next_seq AS (
             UPDATE groups g
             SET last_seq = g.last_seq + 1
             FROM can_insert ci
             WHERE g.id = $2 AND ci.go
             RETURNING g.last_seq AS seq
         ),
         inserted_msg AS (
             INSERT INTO group_messages (
                 id, group_id, seq, sender_agent_id, client_msg_id, payload_hash,
                 content, reply_to_msg_id, mention_agent_ids
             )
             SELECT $1, $2, ns.seq, $3, $4, $5, $6, $7, $8
             FROM next_seq ns
             RETURNING id, seq, content, reply_to_msg_id, mention_agent_ids, created_at
         ),
         -- 按 agent_id 升序加 FOR NO KEY UPDATE 锁：既消除交叉 @ 死锁，又不阻塞其他表外键引用
         locked_agents AS (
             SELECT id
             FROM agents
             WHERE id = ANY($9::uuid[])
               AND EXISTS(SELECT 1 FROM inserted_msg)
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
                 recipient_agent_id, inbox_seq, kind, source_id, group_id, actor_agent_id, summary
             )
             SELECT ba.recipient_agent_id, ba.inbox_seq, 'group_mention', im.id, $2, $3, $10
             FROM bumped_agents ba
             CROSS JOIN inserted_msg im
             RETURNING recipient_agent_id, inbox_seq, created_at
         )
         SELECT
             EXISTS(SELECT 1 FROM grp) AS group_exists,
             (SELECT ok FROM member_ok) AS member_ok,
             (SELECT ok FROM mentions_ok) AS mentions_ok,
             (SELECT ok FROM reply_ok) AS reply_ok,
             EXISTS(SELECT 1 FROM inserted_msg) AS is_new,
             (SELECT payload_hash FROM existing) AS existing_hash,
             COALESCE((SELECT id FROM inserted_msg), (SELECT id FROM existing)) AS msg_id,
             COALESCE((SELECT seq FROM inserted_msg), (SELECT seq FROM existing)) AS seq,
             COALESCE((SELECT content FROM inserted_msg), (SELECT content FROM existing)) AS content,
             COALESCE((SELECT reply_to_msg_id FROM inserted_msg), (SELECT reply_to_msg_id FROM existing)) AS reply_to_msg_id,
             COALESCE((SELECT mention_agent_ids FROM inserted_msg), (SELECT mention_agent_ids FROM existing)) AS mention_agent_ids,
             COALESCE((SELECT created_at FROM inserted_msg), (SELECT created_at FROM existing)) AS created_at,
             COALESCE(
                 (SELECT json_agg(json_build_object(
                     'recipient_agent_id', recipient_agent_id,
                     'inbox_seq', inbox_seq,
                     'created_at', created_at
                 )) FROM inserted_inbox),
                 '[]'::json
             ) AS inbox_entries",
    )
    .bind(new_msg_id)
    .bind(group_id)
    .bind(sender_agent_id)
    .bind(client_msg_id)
    .bind(payload_hash.as_slice())
    .bind(content)
    .bind(reply_to_msg_id)
    .bind(mentions)
    .bind(inbox_recipients)
    .bind(summary)
    .fetch_one(&state.db)
    .await
}

async fn resolve_concurrent_idempotent_group_msg(
    state: &AppState,
    group_id: Uuid,
    sender_agent_id: Uuid,
    client_msg_id: &str,
    payload_hash: &[u8; 32],
) -> Result<(StatusCode, Json<GroupMessageEnvelope>), AppError> {
    #[derive(FromRow)]
    struct ExistingRow {
        id: Uuid,
        group_id: Uuid,
        seq: i64,
        sender_agent_id: Uuid,
        client_msg_id: String,
        payload_hash: Vec<u8>,
        content: String,
        reply_to_msg_id: Option<Uuid>,
        mention_agent_ids: Vec<Uuid>,
        created_at: DateTime<Utc>,
    }

    let row = sqlx::query_as::<_, ExistingRow>(
        "SELECT id, group_id, seq, sender_agent_id, client_msg_id, payload_hash,
                content, reply_to_msg_id, mention_agent_ids, created_at
         FROM group_messages
         WHERE group_id = $1 AND sender_agent_id = $2 AND client_msg_id = $3",
    )
    .bind(group_id)
    .bind(sender_agent_id)
    .bind(client_msg_id)
    .fetch_one(&state.db)
    .await?;

    if row.payload_hash.as_slice() != payload_hash.as_slice() {
        return Err(AppError::Conflict(
            "client_msg_id already used with a different message payload".into(),
        ));
    }

    Ok((
        StatusCode::OK,
        Json(GroupMessageEnvelope {
            message: GroupMessageView {
                id: row.id,
                group_id: row.group_id,
                seq: row.seq,
                sender_agent_id: row.sender_agent_id,
                client_msg_id: row.client_msg_id,
                content: row.content,
                reply_to_msg_id: row.reply_to_msg_id,
                mention_agent_ids: row.mention_agent_ids,
                created_at: row.created_at,
            },
        }),
    ))
}

fn extract_msg_from_cte_row(
    group_id: Uuid,
    sender_agent_id: Uuid,
    client_msg_id: &str,
    row: PostGroupMsgCteRow,
) -> Result<GroupMessageView, AppError> {
    Ok(GroupMessageView {
        id: row
            .msg_id
            .ok_or_else(|| AppError::Internal("missing msg_id from CTE".into()))?,
        group_id,
        seq: row
            .seq
            .ok_or_else(|| AppError::Internal("missing seq from CTE".into()))?,
        sender_agent_id,
        client_msg_id: client_msg_id.to_owned(),
        content: row
            .content
            .ok_or_else(|| AppError::Internal("missing content from CTE".into()))?,
        reply_to_msg_id: row.reply_to_msg_id,
        mention_agent_ids: row.mention_agent_ids.unwrap_or_default(),
        created_at: row
            .created_at
            .ok_or_else(|| AppError::Internal("missing created_at from CTE".into()))?,
    })
}

fn compute_group_msg_hash(
    content: &str,
    reply_to_msg_id: Option<Uuid>,
    mentions: &[Uuid],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update((content.len() as u64).to_le_bytes());
    hasher.update(content.as_bytes());
    match reply_to_msg_id {
        Some(id) => {
            hasher.update([1u8]);
            hasher.update(id.as_bytes());
        }
        None => hasher.update([0u8]),
    }
    hasher.update((mentions.len() as u64).to_le_bytes());
    for id in mentions {
        hasher.update(id.as_bytes());
    }
    hasher.finalize().into()
}

pub(crate) fn truncate_summary(content: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in content.chars().enumerate() {
        if idx >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

async fn fetch_group_view(state: &AppState, group_id: Uuid) -> Result<GroupView, AppError> {
    sqlx::query_as::<_, GroupView>(
        "SELECT g.id, g.slug, g.name, g.description, g.last_seq,
                COUNT(gm.agent_id) AS member_count, g.created_at
         FROM groups g
         LEFT JOIN group_members gm ON gm.group_id = g.id
         WHERE g.id = $1
         GROUP BY g.id",
    )
    .bind(group_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("group not found".into()))
}

async fn fetch_group_members(
    state: &AppState,
    group_id: Uuid,
) -> Result<Vec<GroupMemberView>, AppError> {
    sqlx::query_as::<_, GroupMemberView>(
        "SELECT a.id AS agent_id, a.slug, a.display_name, a.framework, gm.joined_at
         FROM group_members gm
         JOIN agents a ON a.id = gm.agent_id
         WHERE gm.group_id = $1
         ORDER BY gm.joined_at ASC, a.id ASC",
    )
    .bind(group_id)
    .fetch_all(&state.db)
    .await
    .map_err(AppError::from)
}

fn collect_requested_member_ids(req: AddGroupMembersRequest) -> Result<Vec<Uuid>, AppError> {
    let mut ids = req.agent_ids.as_slice().to_vec();
    if let Some(single) = req.agent_id {
        ids.push(single);
    }
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Err(AppError::Unprocessable(
            "must provide at least one agent_id or agent_ids".into(),
        ));
    }
    Ok(ids)
}

fn notify_members_joined(state: &AppState, group_id: Uuid, group_slug: &str, agent_ids: &[Uuid]) {
    if agent_ids.is_empty() {
        return;
    }
    let frame = encode_event(&json!({
        "type": "group_joined",
        "group_id": group_id,
        "group_slug": group_slug,
    }));
    for &agent_id in agent_ids {
        state.events.send_agent(
            agent_id,
            AgentSignal::JoinGroup {
                group_id,
                frame: frame.clone(),
            },
        );
    }
}

fn map_group_slug_conflict(err: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_err) = &err {
        if db_err.code().as_deref() == Some("23505") {
            return AppError::Conflict("group slug already exists".into());
        }
    }
    AppError::from(err)
}
