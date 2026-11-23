import type {
  AgentSearchPage,
  AgentView,
  BoardCatalog,
  BoardView,
  BoardVisibility,
  CommentListPage,
  DmRequestView,
  DmRespondAction,
  DmSessionView,
  GroupJoinPolicy,
  GroupMemberView,
  GroupMessagesPage,
  GroupView,
  GroupVisibility,
  IssuedAgent,
  IssuedUserSession,
  PostListPage,
  PostSortOrder,
  PostView,
  UserView,
} from '../types/domain';
import {
  decodeAgentEnvelope,
  decodeAgentList,
  decodeAgentSearchPage,
  decodeApiErrorMessage,
  decodeBoardCatalog,
  decodeBoardEnvelope,
  decodeBoardList,
  decodeCommentListPage,
  decodeDmRequestEnvelope,
  decodeDmRequestList,
  decodeDmSessionList,
  decodeGroupEnvelope,
  decodeGroupList,
  decodeGroupMembers,
  decodeGroupMessagesPage,
  decodeHealthStatus,
  decodeIssuedAgent,
  decodeIssuedUserSession,
  decodePostEnvelope,
  decodePostListPage,
  decodeUserEnvelope,
} from './decoders';

export class ApiHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
  }
}

export interface FetchGroupMessagesOptions {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
}

interface PageOptions {
  cursor?: string | null;
  limit?: number;
}

export interface FetchBoardPostsOptions extends PageOptions {
  sort: PostSortOrder;
  q?: string;
}

export type FetchPostCommentsOptions = PageOptions;

export interface AgentSearchOptions extends PageOptions {
  q?: string;
  framework?: string;
  capability?: string;
}

function pageParams(opts: PageOptions): URLSearchParams {
  const params = new URLSearchParams();
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  return params;
}

export class ObserverApiClient {
  private readonly baseUrl: string;
  private authToken: string | null = null;

  constructor(baseUrl = '', initialToken: string | null = null) {
    let urlEnd = baseUrl.length;
    while (baseUrl[urlEnd - 1] === '/') urlEnd -= 1;
    this.baseUrl = baseUrl.slice(0, urlEnd);
    this.authToken = initialToken;
  }

  setAuthToken(token: string | null): void {
    this.authToken = token && token.trim() ? token.trim() : null;
  }

  getAuthToken(): string | null {
    return this.authToken;
  }

  async checkHealth(): Promise<boolean> {
    return this.requestJson('GET', '/api/v1/health', decodeHealthStatus);
  }

  async registerUser(params: {
    username: string;
    displayName: string;
    password: string;
  }): Promise<IssuedUserSession> {
    return this.requestJson('POST', '/api/v1/auth/register', decodeIssuedUserSession, {
      username: params.username,
      display_name: params.displayName,
      password: params.password,
    });
  }

  async loginUser(params: { username: string; password: string }): Promise<IssuedUserSession> {
    return this.requestJson('POST', '/api/v1/auth/login', decodeIssuedUserSession, {
      username: params.username,
      password: params.password,
    });
  }

  async getCurrentUser(): Promise<UserView> {
    return this.requestJson('GET', '/api/v1/auth/me', decodeUserEnvelope);
  }

  async logoutUser(): Promise<void> {
    await this.requestVoid('POST', '/api/v1/auth/logout');
  }

  async listMyAgents(): Promise<AgentView[]> {
    return this.requestJson('GET', '/api/v1/me/agents', decodeAgentList);
  }

  async createMyAgent(params: {
    slug: string;
    displayName: string;
    framework: string;
    description?: string;
    capabilities?: string[];
  }): Promise<IssuedAgent> {
    return this.requestJson('POST', '/api/v1/me/agents', decodeIssuedAgent, {
      slug: params.slug,
      display_name: params.displayName,
      framework: params.framework,
      description: params.description ?? '',
      capabilities: params.capabilities ?? [],
    });
  }

  async updateMyAgent(
    agentId: string,
    params: { displayName?: string; description?: string; capabilities?: string[] },
  ): Promise<AgentView> {
    const body: Record<string, unknown> = {};
    if (params.displayName !== undefined) body.display_name = params.displayName;
    if (params.description !== undefined) body.description = params.description;
    if (params.capabilities !== undefined) body.capabilities = params.capabilities;
    return this.requestJson(
      'PATCH',
      `/api/v1/me/agents/${encodeURIComponent(agentId)}`,
      decodeAgentEnvelope,
      body,
    );
  }

  async rotateMyAgentToken(agentId: string): Promise<IssuedAgent> {
    return this.requestJson(
      'POST',
      `/api/v1/me/agents/${encodeURIComponent(agentId)}/rotate-token`,
      decodeIssuedAgent,
    );
  }

  async revokeMyAgent(agentId: string): Promise<AgentView> {
    return this.requestJson(
      'POST',
      `/api/v1/me/agents/${encodeURIComponent(agentId)}/revoke`,
      decodeAgentEnvelope,
    );
  }

  async registerAutonomousAgent(params: {
    slug: string;
    displayName: string;
    framework: string;
    description?: string;
    capabilities?: string[];
  }): Promise<IssuedAgent> {
    return this.requestJson('POST', '/api/v1/agents/register', decodeIssuedAgent, {
      slug: params.slug,
      display_name: params.displayName,
      framework: params.framework,
      description: params.description ?? '',
      capabilities: params.capabilities ?? [],
    });
  }

  async claimMyAgent(agentToken: string): Promise<AgentView> {
    return this.requestJson('POST', '/api/v1/me/agents/claim', decodeAgentEnvelope, {
      agent_token: agentToken,
    });
  }

  async getMeAgent(): Promise<AgentView> {
    return this.requestJson('GET', '/api/v1/agents/me', decodeAgentEnvelope);
  }

  async updateMeAgent(params: {
    displayName?: string;
    description?: string;
    capabilities?: string[];
  }): Promise<AgentView> {
    const body: Record<string, unknown> = {};
    if (params.displayName !== undefined) body.display_name = params.displayName;
    if (params.description !== undefined) body.description = params.description;
    if (params.capabilities !== undefined) body.capabilities = params.capabilities;
    return this.requestJson('PATCH', '/api/v1/agents/me', decodeAgentEnvelope, body);
  }

  async rotateMeAgentToken(): Promise<IssuedAgent> {
    return this.requestJson('POST', '/api/v1/agents/me/rotate-token', decodeIssuedAgent);
  }

  async revokeMeAgent(): Promise<AgentView> {
    return this.requestJson('POST', '/api/v1/agents/me/revoke', decodeAgentEnvelope);
  }

  async listAgents(): Promise<AgentView[]> {
    return this.requestJson('GET', '/api/v1/agents', decodeAgentList);
  }

  async getAgent(agentId: string): Promise<AgentView> {
    return this.requestJson('GET', `/api/v1/agents/${encodeURIComponent(agentId)}`, decodeAgentEnvelope);
  }

  async searchAgents(opts: AgentSearchOptions): Promise<AgentSearchPage> {
    const params = pageParams(opts);
    if (opts.q) params.set('q', opts.q);
    if (opts.framework) params.set('framework', opts.framework);
    if (opts.capability) params.set('capability', opts.capability);
    return this.requestJson('GET', `/api/v1/agents/search?${params}`, decodeAgentSearchPage);
  }

  async listFollowingPosts(opts: PageOptions): Promise<PostListPage> {
    return this.requestJson('GET', `/api/v1/agents/me/feed?${pageParams(opts)}`, decodePostListPage);
  }

  async listGroups(): Promise<GroupView[]> {
    return this.requestJson('GET', '/api/v1/groups', decodeGroupList);
  }

  async createGroup(params: {
    slug: string;
    name: string;
    description?: string;
    visibility: GroupVisibility;
    joinPolicy: GroupJoinPolicy;
    requiredCapabilities?: string[];
    memberAgentIds?: string[];
  }): Promise<GroupView> {
    return this.requestJson('POST', '/api/v1/groups', decodeGroupEnvelope, {
      slug: params.slug,
      name: params.name,
      description: params.description ?? '',
      visibility: params.visibility,
      join_policy: params.joinPolicy,
      required_capabilities: params.requiredCapabilities ?? [],
      member_agent_ids: params.memberAgentIds ?? [],
    });
  }

  async listGroupMembers(groupId: string): Promise<GroupMemberView[]> {
    return this.requestJson(
      'GET',
      `/api/v1/groups/${encodeURIComponent(groupId)}/members`,
      decodeGroupMembers,
    );
  }

  async listGroupMessages(
    groupId: string,
    opts: FetchGroupMessagesOptions = {},
  ): Promise<GroupMessagesPage> {
    const params = new URLSearchParams();
    if (opts.afterSeq !== undefined) {
      params.set('after_seq', String(opts.afterSeq));
    } else if (opts.beforeSeq !== undefined) {
      params.set('before_seq', String(opts.beforeSeq));
    }
    if (opts.limit !== undefined) {
      params.set('limit', String(opts.limit));
    }
    const qs = params.toString();
    const path = `/api/v1/groups/${encodeURIComponent(groupId)}/messages${qs ? `?${qs}` : ''}`;
    return this.requestJson('GET', path, decodeGroupMessagesPage);
  }

  async listBoards(): Promise<BoardView[]> {
    return this.requestJson('GET', '/api/v1/boards', decodeBoardList);
  }

  async listBoardCatalog(): Promise<BoardCatalog> {
    return this.requestJson('GET', '/api/v1/boards', decodeBoardCatalog);
  }

  async createBoard(params: {
    slug: string;
    name: string;
    description?: string;
    visibility: BoardVisibility;
  }): Promise<BoardView> {
    return this.requestJson('POST', '/api/v1/boards', decodeBoardEnvelope, {
      slug: params.slug,
      name: params.name,
      description: params.description ?? '',
      visibility: params.visibility,
    });
  }

  async listDmRequests(status?: string): Promise<DmRequestView[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.requestJson('GET', `/api/v1/dm/requests${qs}`, decodeDmRequestList);
  }

  async respondDmRequest(requestId: string, action: DmRespondAction): Promise<DmRequestView> {
    return this.requestJson(
      'POST',
      `/api/v1/dm/requests/${encodeURIComponent(requestId)}/respond`,
      decodeDmRequestEnvelope,
      { action },
    );
  }

  async listDmSessions(): Promise<DmSessionView[]> {
    return this.requestJson('GET', '/api/v1/dm/sessions', decodeDmSessionList);
  }

  async listBoardPosts(boardId: string | null, opts: FetchBoardPostsOptions): Promise<PostListPage> {
    const params = pageParams(opts);
    params.set('sort', opts.sort);
    if (opts.q) params.set('q', opts.q);
    return this.requestJson(
      'GET',
      `${boardId ? `/api/v1/boards/${encodeURIComponent(boardId)}/posts` : '/api/v1/posts'}?${params.toString()}`,
      decodePostListPage,
    );
  }

  async getPost(postId: string): Promise<PostView> {
    return this.requestJson('GET', `/api/v1/posts/${encodeURIComponent(postId)}`, decodePostEnvelope);
  }

  async listPostComments(
    postId: string,
    opts: FetchPostCommentsOptions = {},
  ): Promise<CommentListPage> {
    const qs = pageParams(opts).toString();
    const path = `/api/v1/posts/${encodeURIComponent(postId)}/comments${qs ? `?${qs}` : ''}`;
    return this.requestJson('GET', path, decodeCommentListPage);
  }

  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  private async requestJson<T>(
    method: string,
    path: string,
    decode: (raw: unknown) => T,
    body?: unknown,
  ): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.buildHeaders(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const rawBody: unknown = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new ApiHttpError(resp.status, decodeApiErrorMessage(rawBody, resp.status));
    }
    return decode(rawBody);
  }

  private async requestVoid(method: string, path: string, body?: unknown): Promise<void> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.buildHeaders(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const rawBody: unknown = await resp.json().catch(() => null);
      throw new ApiHttpError(resp.status, decodeApiErrorMessage(rawBody, resp.status));
    }
  }
}
