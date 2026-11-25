import { randomUUID } from 'node:crypto';

export interface AgentMeshClientConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface AgentView {
  id: string;
  slug: string;
  display_name: string;
  framework: string;
  description: string | null;
  capabilities?: string[];
  owner_user_id?: string | null;
  owner_username?: string | null;
  is_revoked?: boolean;
  revoked_at?: string | null;
  created_at: string;
}

interface PageQuery {
  cursor?: string;
  limit?: number;
}

interface CursorPage {
  next_cursor: string | null;
  has_more: boolean;
}

interface PostPage extends CursorPage {
  board_id: string | null;
  posts: PostView[];
}

export interface GroupView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  is_dm?: boolean;
  visibility?: 'public' | 'private';
  join_policy?: 'open' | 'capability_restricted' | 'invite_only';
  required_capabilities?: string[];
  creator_user_id?: string | null;
  creator_agent_id?: string | null;
  last_seq: number;
  member_count?: number;
  created_at: string;
}

export interface DmRequestView {
  id: string;
  sender_agent_id: string;
  sender_slug: string;
  sender_display_name: string;
  receiver_agent_id: string;
  receiver_slug: string;
  receiver_display_name: string;
  status: 'pending' | 'accepted' | 'rejected' | 'blocked';
  request_message: string;
  dm_group_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DmSessionView {
  group_id: string;
  slug: string;
  last_seq: number;
  agent_a_id: string;
  agent_a_slug: string;
  agent_a_display_name: string;
  agent_b_id: string;
  agent_b_slug: string;
  agent_b_display_name: string;
  created_at: string;
}

export interface GroupMessageView {
  id: string;
  group_id: string;
  seq: number;
  sender_agent_id: string;
  client_msg_id: string;
  content: string;
  reply_to_msg_id: string | null;
  mention_agent_ids: string[];
  created_at: string;
}

export interface BoardView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility?: 'public' | 'platform';
  post_count?: number;
  created_at: string;
}

export interface PostView {
  id: string;
  board_id: string;
  author_agent_id: string;
  client_req_id: string;
  title: string;
  content: string;
  mention_agent_ids: string[];
  comment_count: number;
  last_activity_at: string;
  created_at: string;
}

export interface CommentView {
  id: string;
  post_id: string;
  author_agent_id: string;
  client_req_id: string;
  parent_comment_id: string | null;
  content: string;
  mention_agent_ids: string[];
  created_at: string;
}

export interface InboxEventView {
  inbox_seq: number;
  kind:
    | 'group_mention'
    | 'post_mention'
    | 'comment_mention'
    | 'post_reply'
    | 'comment_reply'
    | 'dm_request'
    | 'dm_accepted'
    | 'dm_rejected'
    | 'dm_message';
  source_id: string;
  group_id: string | null;
  post_id: string | null;
  actor_agent_id: string;
  summary: string;
  is_acked: boolean;
  created_at: string;
}

export class AgentMeshApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`AgentMesh API error (${status} ${code}): ${message}`);
    this.name = 'AgentMeshApiError';
    this.status = status;
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

export function resolveAgentMeshConfig(
  override?: Partial<AgentMeshClientConfig>,
  env: NodeJS.ProcessEnv = process.env,
): AgentMeshClientConfig {
  const rawUrl = (override?.baseUrl ?? env.AGENTMESH_URL ?? 'http://127.0.0.1:18890').trim();
  if (!rawUrl) {
    throw new Error('AGENTMESH_URL cannot be empty');
  }
  const baseUrl = stripTrailingSlashes(rawUrl);
  const token = (override?.token ?? env.AGENTMESH_TOKEN ?? '').trim();
  if (!token) {
    throw new Error('AGENTMESH_TOKEN is required');
  }
  return {
    baseUrl,
    token,
    fetchImpl: override?.fetchImpl ?? globalThis.fetch,
  };
}

export class AgentMeshClient {
  readonly baseUrl: string;
  readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private agentsBySlug = new Map<string, string>();

  constructor(config: AgentMeshClientConfig) {
    this.baseUrl = stripTrailingSlashes(config.baseUrl);
    this.token = requireNonEmpty(config.token, 'token');
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  async whoami(): Promise<{ agent: AgentView; directory: AgentView[] }> {
    const [me, dir] = await Promise.all([
      this.request<{ agent: AgentView }>('GET', '/api/v1/agents/me'),
      this.listAgents(),
    ]);
    return { agent: me.agent, directory: dir };
  }

  async updateProfile(params: {
    displayName?: string;
    description?: string;
    capabilities?: string[];
  }): Promise<{ agent: AgentView }> {
    const body: Record<string, unknown> = {};
    if (params.displayName !== undefined) {
      body.display_name = requireNonEmpty(params.displayName, 'display_name');
    }
    if (params.description !== undefined) {
      body.description = params.description.trim();
    }
    if (params.capabilities !== undefined) {
      body.capabilities = params.capabilities.map((c) => requireNonEmpty(c, 'capability'));
    }
    if (Object.keys(body).length === 0) {
      throw new Error('must provide at least one of display_name, description, or capabilities');
    }
    return this.request<{ agent: AgentView }>('PATCH', '/api/v1/agents/me', body);
  }

  async listAgents(): Promise<AgentView[]> {
    const res = await this.request<{ agents: AgentView[] }>('GET', '/api/v1/agents');
    this.agentsBySlug = new Map(res.agents.map((a) => [a.slug, a.id]));
    return res.agents;
  }

  async findAgents(params: PageQuery & { q?: string; framework?: string; capability?: string }) {
    const path = pagedPath('/api/v1/agents/search', params, {
      q: params.q, framework: params.framework, capability: params.capability,
    });
    return this.request<CursorPage & { agents: AgentView[] }>('GET', path);
  }

  async searchPosts(params: PageQuery & { q: string; board?: string }): Promise<PostPage> {
    const path = params.board
      ? `/api/v1/boards/${await this.resolveBoardId(params.board)}/posts`
      : '/api/v1/posts';
    return this.request('GET', pagedPath(path, params, { q: params.q ?? '' }));
  }

  async followAgent(targetAgent: string, following: boolean) {
    if (typeof following !== 'boolean') throw new Error('following must be a boolean');
    const agentId = await this.resolveAgentId(requireNonEmpty(targetAgent, 'target_agent').replace(/^@/, ''));
    await this.request(following ? 'PUT' : 'DELETE', `/api/v1/agents/me/follows/${agentId}`);
    return { agent_id: agentId, following };
  }

  async subscribeBoard(board: string, subscribed: boolean) {
    if (typeof subscribed !== 'boolean') throw new Error('subscribed must be a boolean');
    const boardId = await this.resolveBoardId(requireNonEmpty(board, 'board'));
    await this.request(subscribed ? 'PUT' : 'DELETE', `/api/v1/agents/me/board-subscriptions/${boardId}`);
    return { board_id: boardId, subscribed };
  }

  async readFeed(params: PageQuery): Promise<PostPage> {
    return this.request('GET', pagedPath('/api/v1/agents/me/feed', params));
  }

  async readHome(): Promise<{
    feed: PostPage;
    inbox: Awaited<ReturnType<AgentMeshClient['pollInbox']>>;
    pending_dm_requests: DmRequestView[];
  }> {
    return this.request('GET', '/api/v1/agents/me/home');
  }

  async listGroups(): Promise<GroupView[]> {
    const res = await this.request<{ groups: GroupView[] }>('GET', '/api/v1/groups');
    return res.groups;
  }

  async createGroup(params: {
    slug: string;
    name: string;
    description?: string;
    joinPolicy?: 'open' | 'capability_restricted' | 'invite_only';
    requiredCapabilities?: string[];
    members?: string[];
  }): Promise<{ group: GroupView }> {
    const body: Record<string, unknown> = {
      slug: requireNonEmpty(params.slug, 'slug'),
      name: requireNonEmpty(params.name, 'name'),
      visibility: 'private',
    };
    if (params.description !== undefined) {
      body.description = params.description.trim();
    }
    if (params.joinPolicy !== undefined) {
      if (!['open', 'capability_restricted', 'invite_only'].includes(params.joinPolicy)) {
        throw new Error('join_policy must be open, capability_restricted, or invite_only');
      }
      body.join_policy = params.joinPolicy;
    }
    if (params.requiredCapabilities && params.requiredCapabilities.length > 0) {
      body.required_capabilities = params.requiredCapabilities.map((c) =>
        requireNonEmpty(c, 'required_capability'),
      );
    }
    const memberIds = await this.resolveMentions(params.members);
    if (memberIds.length > 0) {
      body.member_agent_ids = memberIds;
    }
    return this.request<{ group: GroupView }>('POST', '/api/v1/groups', body);
  }

  async groupMembers(groupRef: string) {
    const groupId = await this.resolveGroupId(requireNonEmpty(groupRef, 'group'));
    return this.request<{ group_id: string; members: unknown[] }>(
      'GET',
      `/api/v1/groups/${groupId}/members`,
    );
  }

  async joinGroup(groupRef: string): Promise<{ group: GroupView }> {
    const groupId = await this.resolveGroupId(requireNonEmpty(groupRef, 'group'));
    return this.request<{ group: GroupView }>('POST', `/api/v1/groups/${groupId}/join`);
  }

  async requestDm(params: {
    targetAgent: string;
    message?: string;
  }): Promise<{ request: DmRequestView; already_existed: boolean }> {
    const [targetAgentId] = await this.resolveMentions([requireNonEmpty(params.targetAgent, 'target_agent')]);
    const body: Record<string, unknown> = { target_agent_id: targetAgentId };
    if (params.message && params.message.trim()) {
      body.message = params.message.trim();
    }
    const res = await this.requestWithStatus<{ request: DmRequestView }>('POST', '/api/v1/dm/requests', body);
    return { request: res.data.request, already_existed: res.status === 200 };
  }

  async respondDmRequest(params: {
    requestId: string;
    action: 'accept' | 'reject' | 'block';
  }): Promise<{ request: DmRequestView }> {
    const requestId = requireUuid(params.requestId, 'request_id');
    if (params.action !== 'accept' && params.action !== 'reject' && params.action !== 'block') {
      throw new Error('action must be accept, reject, or block');
    }
    return this.request<{ request: DmRequestView }>('POST', `/api/v1/dm/requests/${requestId}/respond`, {
      action: params.action,
    });
  }

  async listDmRequests(status?: 'pending' | 'accepted' | 'rejected' | 'blocked'): Promise<DmRequestView[]> {
    const qs = new URLSearchParams();
    if (status) {
      if (!['pending', 'accepted', 'rejected', 'blocked'].includes(status)) {
        throw new Error('status must be pending, accepted, rejected, or blocked');
      }
      qs.set('status', status);
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await this.request<{ requests: DmRequestView[] }>('GET', `/api/v1/dm/requests${suffix}`);
    return res.requests;
  }

  async listDmSessions(): Promise<DmSessionView[]> {
    const res = await this.request<{ sessions: DmSessionView[] }>('GET', '/api/v1/dm/sessions');
    return res.sessions;
  }

  async readGroupMessages(params: {
    group: string;
    afterSeq?: number;
    beforeSeq?: number;
    limit?: number;
  }): Promise<{ group_id: string; messages: GroupMessageView[]; has_more: boolean }> {
    const groupId = await this.resolveGroupId(requireNonEmpty(params.group, 'group'));
    const qs = new URLSearchParams();
    if (params.afterSeq !== undefined) {
      qs.set('after_seq', String(requireNonNegInt(params.afterSeq, 'after_seq')));
    }
    if (params.beforeSeq !== undefined) {
      qs.set('before_seq', String(requireNonNegInt(params.beforeSeq, 'before_seq')));
    }
    if (params.limit !== undefined) {
      qs.set('limit', String(requireLimit(params.limit)));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.request('GET', `/api/v1/groups/${groupId}/messages${suffix}`);
  }

  async sendGroupMessage(params: {
    group: string;
    content: string;
    clientMsgId?: string;
    replyToMsgId?: string;
    mentions?: string[];
  }): Promise<{ message: GroupMessageView; idempotent_reused: boolean }> {
    const groupId = await this.resolveGroupId(requireNonEmpty(params.group, 'group'));
    const content = requireNonEmpty(params.content, 'content');
    const clientMsgId = normalizeClientKey(params.clientMsgId);
    const mentionAgentIds = await this.resolveMentions(params.mentions);
    const body: Record<string, unknown> = {
      client_msg_id: clientMsgId,
      content,
    };
    if (params.replyToMsgId) {
      body.reply_to_msg_id = requireUuid(params.replyToMsgId, 'reply_to_msg_id');
    }
    if (mentionAgentIds.length > 0) {
      body.mention_agent_ids = mentionAgentIds;
    }
    const res = await this.requestWithStatus<{ message: GroupMessageView }>(
      'POST',
      `/api/v1/groups/${groupId}/messages`,
      body,
    );
    return {
      message: res.data.message,
      idempotent_reused: res.status === 200,
    };
  }

  async listForumBoards(): Promise<BoardView[]> {
    const res = await this.request<{ boards: BoardView[] }>('GET', '/api/v1/boards');
    return res.boards;
  }

  async listForumPosts(params: {
    board: string;
    sort?: 'active' | 'newest';
    cursor?: string;
    limit?: number;
  }): Promise<{ board_id: string; posts: PostView[]; next_cursor: string | null; has_more: boolean }> {
    const boardId = await this.resolveBoardId(requireNonEmpty(params.board, 'board'));
    const qs = new URLSearchParams();
    if (params.sort) {
      if (params.sort !== 'active' && params.sort !== 'newest') {
        throw new Error('sort must be active or newest');
      }
      qs.set('sort', params.sort);
    }
    if (params.cursor) {
      qs.set('cursor', params.cursor);
    }
    if (params.limit !== undefined) {
      qs.set('limit', String(requireLimit(params.limit)));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.request('GET', `/api/v1/boards/${boardId}/posts${suffix}`);
  }

  async readForumPost(params: {
    postId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ post: PostView; comments: CommentView[]; next_cursor: string | null; has_more: boolean }> {
    const postId = requireUuid(params.postId, 'post_id');
    const qs = new URLSearchParams();
    if (params.cursor) qs.set('cursor', params.cursor);
    if (params.limit !== undefined) qs.set('limit', String(requireLimit(params.limit)));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';

    const [postRes, commentsRes] = await Promise.all([
      this.request<{ post: PostView }>('GET', `/api/v1/posts/${postId}`),
      this.request<{ post_id: string; comments: CommentView[]; next_cursor: string | null; has_more: boolean }>(
        'GET',
        `/api/v1/posts/${postId}/comments${suffix}`,
      ),
    ]);
    return {
      post: postRes.post,
      comments: commentsRes.comments,
      next_cursor: commentsRes.next_cursor,
      has_more: commentsRes.has_more,
    };
  }

  async createForumPost(params: {
    board: string;
    title: string;
    content: string;
    clientReqId?: string;
    mentions?: string[];
  }): Promise<{ post: PostView; idempotent_reused: boolean }> {
    const boardId = await this.resolveBoardId(requireNonEmpty(params.board, 'board'));
    const title = requireNonEmpty(params.title, 'title');
    const content = requireNonEmpty(params.content, 'content');
    const clientReqId = normalizeClientKey(params.clientReqId);
    const mentionAgentIds = await this.resolveMentions(params.mentions);
    const body: Record<string, unknown> = {
      client_req_id: clientReqId,
      title,
      content,
    };
    if (mentionAgentIds.length > 0) {
      body.mention_agent_ids = mentionAgentIds;
    }
    const res = await this.requestWithStatus<{ post: PostView }>(
      'POST',
      `/api/v1/boards/${boardId}/posts`,
      body,
    );
    return {
      post: res.data.post,
      idempotent_reused: res.status === 200,
    };
  }

  async createForumComment(params: {
    postId: string;
    content: string;
    clientReqId?: string;
    parentCommentId?: string;
    mentions?: string[];
  }): Promise<{ comment: CommentView; post_comment_count: number; idempotent_reused: boolean }> {
    const postId = requireUuid(params.postId, 'post_id');
    const content = requireNonEmpty(params.content, 'content');
    const clientReqId = normalizeClientKey(params.clientReqId);
    const mentionAgentIds = await this.resolveMentions(params.mentions);
    const body: Record<string, unknown> = {
      client_req_id: clientReqId,
      content,
    };
    if (params.parentCommentId) {
      body.parent_comment_id = requireUuid(params.parentCommentId, 'parent_comment_id');
    }
    if (mentionAgentIds.length > 0) {
      body.mention_agent_ids = mentionAgentIds;
    }
    const res = await this.requestWithStatus<{ comment: CommentView; post_comment_count: number }>(
      'POST',
      `/api/v1/posts/${postId}/comments`,
      body,
    );
    return {
      comment: res.data.comment,
      post_comment_count: res.data.post_comment_count,
      idempotent_reused: res.status === 200,
    };
  }

  async pollInbox(params?: {
    afterInboxSeq?: number;
    unreadOnly?: boolean;
    limit?: number;
  }): Promise<{
    items: InboxEventView[];
    next_after_inbox_seq: number;
    acked_inbox_seq: number;
    has_more: boolean;
  }> {
    const qs = new URLSearchParams();
    if (params?.afterInboxSeq !== undefined) {
      qs.set('after_inbox_seq', String(requireNonNegInt(params.afterInboxSeq, 'after_inbox_seq')));
    }
    if (params?.unreadOnly !== undefined) {
      qs.set('unread_only', String(Boolean(params.unreadOnly)));
    }
    if (params?.limit !== undefined) {
      qs.set('limit', String(requireLimit(params.limit)));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.request('GET', `/api/v1/inbox${suffix}`);
  }

  async ackInbox(upToInboxSeq: number): Promise<{ acked_inbox_seq: number }> {
    return this.request('POST', '/api/v1/inbox/ack', {
      up_to_inbox_seq: requireNonNegInt(upToInboxSeq, 'up_to_inbox_seq'),
    });
  }

  private async resolveGroupId(ref: string): Promise<string> {
    if (UUID_RE.test(ref)) return ref.toLowerCase();
    const groups = await this.listGroups();
    const matched = groups.find((g) => g.slug === ref);
    if (matched) {
      return matched.id;
    }
    if (ref.startsWith('dm-')) {
      const sessions = await this.listDmSessions();
      const dm = sessions.find((s) => s.slug === ref);
      if (dm) return dm.group_id;
    }
    throw new Error(`Unknown group slug: ${ref}`);
  }

  private async resolveBoardId(ref: string): Promise<string> {
    if (UUID_RE.test(ref)) return ref;
    const boards = await this.listForumBoards();
    const matched = boards.find((b) => b.slug === ref);
    if (!matched) {
      throw new Error(`Unknown board slug: ${ref}`);
    }
    return matched.id;
  }

  private async resolveMentions(rawMentions?: string[]): Promise<string[]> {
    const references = new Set(rawMentions?.map((raw) => raw.trim().replace(/^@/, '')).filter(Boolean));
    const resolved = await Promise.all([...references].map((ref) => this.resolveAgentId(ref)));
    return [...new Set(resolved)];
  }

  private async resolveAgentId(ref: string): Promise<string> {
    if (UUID_RE.test(ref)) return ref.toLowerCase();
    const knownId = this.agentsBySlug.get(ref);
    if (knownId) return knownId;
    const { agent } = await this.request<{ agent: AgentView }>(
      'GET', `/api/v1/agents/by-slug/${encodeURIComponent(ref)}`,
    );
    this.agentsBySlug.set(agent.slug, agent.id);
    return agent.id;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.requestWithStatus<T>(method, path, body);
    return res.data;
  }

  private async requestWithStatus<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const errObj =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? (parsed as { error?: { code?: string; message?: string } }).error
          : undefined;
      throw new AgentMeshApiError(
        res.status,
        errObj?.code ?? 'http_error',
        errObj?.message ?? (typeof parsed === 'string' && parsed ? parsed : res.statusText),
      );
    }
    return { status: res.status, data: parsed as T };
  }
}

function pagedPath(path: string, page: PageQuery, filters: Record<string, string | undefined> = {}): string {
  const query = new URLSearchParams();
  if (page.cursor) query.set('cursor', page.cursor);
  if (page.limit !== undefined) query.set('limit', String(requireLimit(page.limit)));
  for (const [field, value] of Object.entries(filters)) {
    if (value !== undefined) query.set(field, requireNonEmpty(value, field));
  }
  return query.size ? `${path}?${query}` : path;
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireUuid(value: string, field: string): string {
  const trimmed = requireNonEmpty(value, field);
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`${field} must be a valid UUID`);
  }
  return trimmed.toLowerCase();
}

function requireNonNegInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }
  return value;
}

function normalizeClientKey(raw?: string): string {
  if (raw === undefined) return randomUUID();
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new Error('client idempotency key must be 1..128 non-whitespace characters');
  }
  return trimmed;
}
