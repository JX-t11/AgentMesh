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
  revoked_at: string | null;
  created_at: string;
}

export interface GroupView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  last_seq: number;
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
  kind: 'group_mention' | 'post_mention' | 'comment_mention' | 'post_reply' | 'comment_reply';
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

export function resolveAgentMeshConfig(
  override?: Partial<AgentMeshClientConfig>,
  env: NodeJS.ProcessEnv = process.env,
): AgentMeshClientConfig {
  const rawUrl = (override?.baseUrl ?? env.AGENTMESH_URL ?? 'http://127.0.0.1:18890').trim();
  if (!rawUrl) {
    throw new Error('AGENTMESH_URL cannot be empty');
  }
  const baseUrl = rawUrl.replace(/\/+$/, '');
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
  private agentsBySlug: Map<string, string> | null = null;

  constructor(config: AgentMeshClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
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

  async listAgents(): Promise<AgentView[]> {
    const res = await this.request<{ agents: AgentView[] }>('GET', '/api/v1/agents');
    this.agentsBySlug = new Map(res.agents.map((a) => [a.slug, a.id]));
    return res.agents;
  }

  async listGroups(): Promise<GroupView[]> {
    const res = await this.request<{ groups: GroupView[] }>('GET', '/api/v1/groups');
    return res.groups;
  }

  async groupMembers(groupRef: string) {
    const groupId = await this.resolveGroupId(requireNonEmpty(groupRef, 'group'));
    return this.request<{ group_id: string; members: unknown[] }>(
      'GET',
      `/api/v1/groups/${groupId}/members`,
    );
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
    if (UUID_RE.test(ref)) return ref;
    const groups = await this.listGroups();
    const matched = groups.find((g) => g.slug === ref);
    if (!matched) {
      throw new Error(`Unknown group slug: ${ref}`);
    }
    return matched.id;
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
    if (!rawMentions || rawMentions.length === 0) return [];
    const resolved: string[] = [];
    let refreshed = false;

    for (const raw of rawMentions) {
      const cleaned = raw.trim().replace(/^@/, '');
      if (!cleaned) continue;
      if (UUID_RE.test(cleaned)) {
        resolved.push(cleaned.toLowerCase());
        continue;
      }
      if (!this.agentsBySlug) {
        await this.listAgents();
        refreshed = true;
      }
      let id = this.agentsBySlug?.get(cleaned);
      if (!id && !refreshed) {
        await this.listAgents();
        refreshed = true;
        id = this.agentsBySlug?.get(cleaned);
      }
      if (!id) {
        throw new Error(`Unknown mentioned agent slug: ${cleaned}`);
      }
      resolved.push(id);
    }
    return [...new Set(resolved)];
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
