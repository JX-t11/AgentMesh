import type {
  AgentView,
  BoardCatalog,
  BoardView,
  BoardVisibility,
  CommentListPage,
  CommentView,
  DmRequestView,
  DmSessionView,
  GroupJoinPolicy,
  GroupMemberView,
  GroupMessagesPage,
  GroupMessageView,
  GroupView,
  GroupVisibility,
  IssuedAgent,
  IssuedUserSession,
  ObserverWsEvent,
  PostListPage,
  PostView,
  UserView,
} from '../types/domain';

export class PayloadDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadDecodeError';
  }
}

export function decodeHealthStatus(raw: unknown): boolean {
  const obj = expectRecord(raw, 'health');
  return expectString(obj.status, 'health.status') === 'ok';
}

export function decodeUserEnvelope(raw: unknown): UserView {
  const obj = expectRecord(raw, 'userEnvelope');
  return decodeUser(obj.user, 'userEnvelope.user');
}

export function decodeIssuedUserSession(raw: unknown): IssuedUserSession {
  const obj = expectRecord(raw, 'issuedUserSession');
  return {
    user: decodeUser(obj.user, 'issuedUserSession.user'),
    token: expectNonEmptyString(obj.token, 'issuedUserSession.token'),
  };
}

export function decodeAgentEnvelope(raw: unknown): AgentView {
  const obj = expectRecord(raw, 'agentEnvelope');
  return decodeAgent(obj.agent, 'agentEnvelope.agent');
}

export function decodeIssuedAgent(raw: unknown): IssuedAgent {
  const obj = expectRecord(raw, 'issuedAgent');
  return {
    agent: decodeAgent(obj.agent, 'issuedAgent.agent'),
    token: expectNonEmptyString(obj.token, 'issuedAgent.token'),
  };
}

export function decodeAgentList(raw: unknown): AgentView[] {
  const obj = expectRecord(raw, 'agentList');
  return expectArray(obj.agents, 'agentList.agents').map((item, idx) =>
    decodeAgent(item, `agents[${idx}]`),
  );
}

export function decodeGroupEnvelope(raw: unknown): GroupView {
  const obj = expectRecord(raw, 'groupEnvelope');
  return decodeGroup(obj.group, 'groupEnvelope.group');
}

export function decodeGroupList(raw: unknown): GroupView[] {
  const obj = expectRecord(raw, 'groupList');
  return expectArray(obj.groups, 'groupList.groups').map((item, idx) =>
    decodeGroup(item, `groups[${idx}]`),
  );
}

export function decodeGroupMembers(raw: unknown): GroupMemberView[] {
  const obj = expectRecord(raw, 'groupMembers');
  expectNonEmptyString(obj.group_id, 'groupMembers.group_id');
  return expectArray(obj.members, 'groupMembers.members').map((item, idx) =>
    decodeGroupMember(item, `members[${idx}]`),
  );
}

export function decodeGroupMessagesPage(raw: unknown): GroupMessagesPage {
  const obj = expectRecord(raw, 'groupMessagesPage');
  return {
    groupId: expectNonEmptyString(obj.group_id, 'groupMessagesPage.group_id'),
    messages: expectArray(obj.messages, 'groupMessagesPage.messages').map((item, idx) =>
      decodeGroupMessage(item, `messages[${idx}]`),
    ),
    hasMore: expectBoolean(obj.has_more, 'groupMessagesPage.has_more'),
  };
}

export function decodeBoardEnvelope(raw: unknown): BoardView {
  const obj = expectRecord(raw, 'boardEnvelope');
  return decodeBoard(obj.board, 'boardEnvelope.board');
}

export function decodeBoardCatalog(raw: unknown): BoardCatalog {
  const obj = expectRecord(raw, 'boardList');
  const boards = expectArray(obj.boards, 'boardList.boards').map((item, idx) =>
    decodeBoard(item, `boards[${idx}]`),
  );
  const hiddenPlatformCount =
    obj.hidden_platform_count === undefined
      ? 0
      : expectSafeInt(obj.hidden_platform_count, 'boardList.hidden_platform_count');
  return { boards, hiddenPlatformCount };
}

export function decodeBoardList(raw: unknown): BoardView[] {
  return decodeBoardCatalog(raw).boards;
}

export function decodeDmRequestEnvelope(raw: unknown): DmRequestView {
  const obj = expectRecord(raw, 'dmRequestEnvelope');
  return decodeDmRequest(obj.request, 'dmRequestEnvelope.request');
}

export function decodeDmRequestList(raw: unknown): DmRequestView[] {
  const obj = expectRecord(raw, 'dmRequestList');
  return expectArray(obj.requests, 'dmRequestList.requests').map((item, idx) =>
    decodeDmRequest(item, `requests[${idx}]`),
  );
}

export function decodeDmSessionList(raw: unknown): DmSessionView[] {
  const obj = expectRecord(raw, 'dmSessionList');
  return expectArray(obj.sessions, 'dmSessionList.sessions').map((item, idx) =>
    decodeDmSession(item, `sessions[${idx}]`),
  );
}

export function decodePostListPage(raw: unknown): PostListPage {
  const obj = expectRecord(raw, 'postListPage');
  return {
    boardId: obj.board_id === null ? null : expectNonEmptyString(obj.board_id, 'postListPage.board_id'),
    posts: expectArray(obj.posts, 'postListPage.posts').map((item, idx) =>
      decodePost(item, `posts[${idx}]`),
    ),
    nextCursor: expectNullableString(obj.next_cursor, 'postListPage.next_cursor'),
    hasMore: expectBoolean(obj.has_more, 'postListPage.has_more'),
  };
}

export function decodePostEnvelope(raw: unknown): PostView {
  const obj = expectRecord(raw, 'postEnvelope');
  return decodePost(obj.post, 'postEnvelope.post');
}

export function decodeCommentListPage(raw: unknown): CommentListPage {
  const obj = expectRecord(raw, 'commentListPage');
  return {
    postId: expectNonEmptyString(obj.post_id, 'commentListPage.post_id'),
    comments: expectArray(obj.comments, 'commentListPage.comments').map((item, idx) =>
      decodeComment(item, `comments[${idx}]`),
    ),
    nextCursor: expectNullableString(obj.next_cursor, 'commentListPage.next_cursor'),
    hasMore: expectBoolean(obj.has_more, 'commentListPage.has_more'),
  };
}

export function decodeObserverWsFrame(rawText: string): ObserverWsEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new PayloadDecodeError('invalid JSON in observer WebSocket frame');
  }

  const obj = expectRecord(parsed, 'wsFrame');
  const eventType = expectNonEmptyString(obj.type, 'wsFrame.type');

  switch (eventType) {
    case 'connected': {
      const role = expectString(obj.role, 'wsFrame.role');
      if (role !== 'observer') {
        throw new PayloadDecodeError(`unexpected connected role: ${role}`);
      }
      return { type: 'connected', role: 'observer' };
    }
    case 'subscribed':
      return {
        type: 'subscribed',
        groups: expectStringArray(obj.groups, 'wsFrame.groups'),
        forum: expectBoolean(obj.forum, 'wsFrame.forum'),
      };
    case 'pong':
      return { type: 'pong' };
    case 'group_message':
      return {
        type: 'group_message',
        message: decodeGroupMessage(obj.message, 'wsFrame.message'),
      };
    case 'post_created':
      return {
        type: 'post_created',
        post: decodePost(obj.post, 'wsFrame.post'),
      };
    case 'comment_created':
      return {
        type: 'comment_created',
        comment: decodeComment(obj.comment, 'wsFrame.comment'),
        postCommentCount: expectSafeInt(obj.post_comment_count, 'wsFrame.post_comment_count'),
      };
    case 'resync_required': {
      const scope = expectString(obj.scope, 'wsFrame.scope');
      const dropped = expectSafeInt(obj.dropped, 'wsFrame.dropped');
      if (scope === 'group') {
        return {
          type: 'resync_required',
          scope: 'group',
          scopeId: expectNonEmptyString(obj.scope_id, 'wsFrame.scope_id'),
          dropped,
        };
      }
      if (scope === 'forum') {
        return {
          type: 'resync_required',
          scope: 'forum',
          scopeId: null,
          dropped,
        };
      }
      throw new PayloadDecodeError(`unsupported resync_required scope: ${scope}`);
    }
    case 'error':
      return {
        type: 'error',
        code: expectString(obj.code, 'wsFrame.code'),
        message: expectString(obj.message, 'wsFrame.message'),
      };
    default:
      throw new PayloadDecodeError(`unknown observer ws event type: ${eventType}`);
  }
}

export function decodeApiErrorMessage(raw: unknown, fallbackStatus: number): string {
  if (typeof raw === 'object' && raw !== null && 'error' in raw) {
    const errObj = (raw as Record<string, unknown>).error;
    if (typeof errObj === 'object' && errObj !== null) {
      const msg = (errObj as Record<string, unknown>).message;
      if (typeof msg === 'string' && msg.length > 0) {
        return msg;
      }
    }
  }
  return `HTTP ${fallbackStatus}`;
}

function decodeUser(raw: unknown, path: string): UserView {
  const obj = expectRecord(raw, path);
  return {
    id: expectNonEmptyString(obj.id, `${path}.id`),
    username: expectNonEmptyString(obj.username, `${path}.username`),
    displayName: expectNonEmptyString(obj.display_name, `${path}.display_name`),
    createdAt: expectNonEmptyString(obj.created_at, `${path}.created_at`),
  };
}

function decodeAgent(raw: unknown, path: string): AgentView {
  const obj = expectRecord(raw, path);
  return {
    id: expectNonEmptyString(obj.id, `${path}.id`),
    slug: expectNonEmptyString(obj.slug, `${path}.slug`),
    displayName: expectNonEmptyString(obj.display_name, `${path}.display_name`),
    framework: expectNonEmptyString(obj.framework, `${path}.framework`),
    description: expectString(obj.description, `${path}.description`),
    capabilities:
      obj.capabilities === undefined
        ? []
        : expectStringArray(obj.capabilities, `${path}.capabilities`),
    ownerUserId: expectNullableString(obj.owner_user_id, `${path}.owner_user_id`),
    ownerUsername: expectNullableString(obj.owner_username, `${path}.owner_username`),
    isRevoked: expectBoolean(obj.is_revoked, `${path}.is_revoked`),
    createdAt: expectNonEmptyString(obj.created_at, `${path}.created_at`),
  };
}

function decodeGroup(raw: unknown, path: string): GroupView {
  const obj = expectRecord(raw, path);
  const visibility = (obj.visibility === 'private' ? 'private' : 'public') as GroupVisibility;
  const joinPolicy = (
    obj.join_policy === 'open' || obj.join_policy === 'capability_restricted'
      ? obj.join_policy
      : 'invite_only'
  ) as GroupJoinPolicy;
  return {
    id: expectNonEmptyString(obj.id, `${path}.id`),
    slug: expectNonEmptyString(obj.slug, `${path}.slug`),
    name: expectNonEmptyString(obj.name, `${path}.name`),
    description: expectString(obj.description, `${path}.description`),
    isDm: obj.is_dm === undefined ? false : expectBoolean(obj.is_dm, `${path}.is_dm`),
    visibility,
    joinPolicy,
    requiredCapabilities:
      obj.required_capabilities === undefined
        ? []
        : expectStringArray(obj.required_capabilities, `${path}.required_capabilities`),
    creatorUserId: expectNullableString(obj.creator_user_id, `${path}.creator_user_id`),
    creatorAgentId: expectNullableString(obj.creator_agent_id, `${path}.creator_agent_id`),
    lastSeq: expectSafeInt(obj.last_seq, `${path}.last_seq`),
    memberCount: expectSafeInt(obj.member_count, `${path}.member_count`),
    createdAt: expectNonEmptyString(obj.created_at, `${path}.created_at`),
  };
}

function decodeGroupMember(raw: unknown, path: string): GroupMemberView {
  const obj = expectRecord(raw, path);
  return {
    agentId: expectNonEmptyString(obj.agent_id, `${path}.agent_id`),
    slug: expectNonEmptyString(obj.slug, `${path}.slug`),
    displayName: expectNonEmptyString(obj.display_name, `${path}.display_name`),
    framework: expectNonEmptyString(obj.framework, `${path}.framework`),
    capabilities:
      obj.capabilities === undefined
        ? []
        : expectStringArray(obj.capabilities, `${path}.capabilities`),
    joinedAt: expectNonEmptyString(obj.joined_at, `${path}.joined_at`),
  };
}

function decodeGroupMessage(raw: unknown, path: string): GroupMessageView {
  const obj = expectRecord(raw, path);
  return {
    id: expectNonEmptyString(obj.id, `${path}.id`),
    groupId: expectNonEmptyString(obj.group_id, `${path}.group_id`),
    seq: expectPositiveInt(obj.seq, `${path}.seq`),
    senderAgentId: expectNonEmptyString(obj.sender_agent_id, `${path}.sender_agent_id`),
    clientMsgId: expectNonEmptyString(obj.client_msg_id, `${path}.client_msg_id`),
    content: expectString(obj.content, `${path}.content`),
    replyToMsgId: expectNullableString(obj.reply_to_msg_id, `${path}.reply_to_msg_id`),
    mentionAgentIds: expectStringArray(obj.mention_agent_ids, `${path}.mention_agent_ids`),
    createdAt: expectNonEmptyString(obj.created_at, `${path}.created_at`),
  };
}

function decodeBoard(raw: unknown, path: string): BoardView {
  const obj = expectRecord(raw, path);
  const visibility = (obj.visibility === 'platform' ? 'platform' : 'public') as BoardVisibility;
  return {
    id: expectNonEmptyString(obj.id, `${path}.id`),
    slug: expectNonEmptyString(obj.slug, `${path}.slug`),
    name: expectNonEmptyString(obj.name, `${path}.name`),
    description: expectString(obj.description, `${path}.description`),
    visibility,
    creatorUserId: expectNullableString(obj.creator_user_id, `${path}.creator_user_id`),
    postCount: expectSafeInt(obj.post_count, `${path}.post_count`),
    createdAt: expectNonEmptyString(obj.created_at, `${path}.created_at`),
  };
}

function decodeDmRequest(raw: unknown, path: string): DmRequestView {
  const obj = expectRecord(raw, path);
  const statusRaw = expectNonEmptyString(obj.status, `${path}.status`);
  const status =
    statusRaw === 'accepted' || statusRaw === 'rejected' || statusRaw === 'blocked'
      ? statusRaw
      : 'pending';
  return {
    id: expectNonEmptyString(obj.id, `${path}.id`),
    senderAgentId: expectNonEmptyString(obj.sender_agent_id, `${path}.sender_agent_id`),
    senderSlug: expectNonEmptyString(obj.sender_slug, `${path}.sender_slug`),
    senderDisplayName: expectNonEmptyString(obj.sender_display_name, `${path}.sender_display_name`),
    receiverAgentId: expectNonEmptyString(obj.receiver_agent_id, `${path}.receiver_agent_id`),
    receiverSlug: expectNonEmptyString(obj.receiver_slug, `${path}.receiver_slug`),
    receiverDisplayName: expectNonEmptyString(
      obj.receiver_display_name,
      `${path}.receiver_display_name`,
    ),
    status,
    requestMessage: expectString(obj.request_message, `${path}.request_message`),
    dmGroupId: expectNullableString(obj.dm_group_id, `${path}.dm_group_id`),
    createdAt: expectNonEmptyString(obj.created_at, `${path}.created_at`),
    updatedAt: expectNonEmptyString(obj.updated_at, `${path}.updated_at`),
  };
}

function decodeDmSession(raw: unknown, path: string): DmSessionView {
  const obj = expectRecord(raw, path);
  return {
    groupId: expectNonEmptyString(obj.group_id, `${path}.group_id`),
    slug: expectNonEmptyString(obj.slug, `${path}.slug`),
    lastSeq: expectSafeInt(obj.last_seq, `${path}.last_seq`),
    agentAId: expectNonEmptyString(obj.agent_a_id, `${path}.agent_a_id`),
    agentASlug: expectNonEmptyString(obj.agent_a_slug, `${path}.agent_a_slug`),
    agentADisplayName: expectNonEmptyString(
      obj.agent_a_display_name,
      `${path}.agent_a_display_name`,
    ),
    agentBId: expectNonEmptyString(obj.agent_b_id, `${path}.agent_b_id`),
    agentBSlug: expectNonEmptyString(obj.agent_b_slug, `${path}.agent_b_slug`),
    agentBDisplayName: expectNonEmptyString(
      obj.agent_b_display_name,
      `${path}.agent_b_display_name`,
    ),
    createdAt: expectNonEmptyString(obj.created_at, `${path}.created_at`),
  };
}

function decodePost(raw: unknown, path: string): PostView {
  const obj = expectRecord(raw, path);
  return {
    id: expectNonEmptyString(obj.id, `${path}.id`),
    boardId: expectNonEmptyString(obj.board_id, `${path}.board_id`),
    authorAgentId: expectNonEmptyString(obj.author_agent_id, `${path}.author_agent_id`),
    clientReqId: expectNonEmptyString(obj.client_req_id, `${path}.client_req_id`),
    title: expectNonEmptyString(obj.title, `${path}.title`),
    content: expectString(obj.content, `${path}.content`),
    mentionAgentIds: expectStringArray(obj.mention_agent_ids, `${path}.mention_agent_ids`),
    commentCount: expectSafeInt(obj.comment_count, `${path}.comment_count`),
    lastActivityAt: expectNonEmptyString(obj.last_activity_at, `${path}.last_activity_at`),
    createdAt: expectNonEmptyString(obj.created_at, `${path}.created_at`),
  };
}

function decodeComment(raw: unknown, path: string): CommentView {
  const obj = expectRecord(raw, path);
  return {
    id: expectNonEmptyString(obj.id, `${path}.id`),
    postId: expectNonEmptyString(obj.post_id, `${path}.post_id`),
    authorAgentId: expectNonEmptyString(obj.author_agent_id, `${path}.author_agent_id`),
    clientReqId: expectNonEmptyString(obj.client_req_id, `${path}.client_req_id`),
    parentCommentId: expectNullableString(obj.parent_comment_id, `${path}.parent_comment_id`),
    content: expectString(obj.content, `${path}.content`),
    mentionAgentIds: expectStringArray(obj.mention_agent_ids, `${path}.mention_agent_ids`),
    createdAt: expectNonEmptyString(obj.created_at, `${path}.created_at`),
  };
}

function expectRecord(val: unknown, path: string): Record<string, unknown> {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) {
    throw new PayloadDecodeError(`${path} must be an object`);
  }
  return val as Record<string, unknown>;
}

function expectArray(val: unknown, path: string): unknown[] {
  if (!Array.isArray(val)) {
    throw new PayloadDecodeError(`${path} must be an array`);
  }
  return val;
}

function expectString(val: unknown, path: string): string {
  if (typeof val !== 'string') {
    throw new PayloadDecodeError(`${path} must be a string`);
  }
  return val;
}

function expectNonEmptyString(val: unknown, path: string): string {
  const s = expectString(val, path);
  if (s.trim().length === 0) {
    throw new PayloadDecodeError(`${path} must not be empty`);
  }
  return s;
}

function expectNullableString(val: unknown, path: string): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  return expectNonEmptyString(val, path);
}

function expectStringArray(val: unknown, path: string): string[] {
  return expectArray(val, path).map((item, idx) => expectNonEmptyString(item, `${path}[${idx}]`));
}

function expectBoolean(val: unknown, path: string): boolean {
  if (typeof val !== 'boolean') {
    throw new PayloadDecodeError(`${path} must be a boolean`);
  }
  return val;
}

function expectSafeInt(val: unknown, path: string): number {
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) {
    throw new PayloadDecodeError(`${path} must be a non-negative integer`);
  }
  return val;
}

function expectPositiveInt(val: unknown, path: string): number {
  const n = expectSafeInt(val, path);
  if (n <= 0) {
    throw new PayloadDecodeError(`${path} must be a positive integer`);
  }
  return n;
}
