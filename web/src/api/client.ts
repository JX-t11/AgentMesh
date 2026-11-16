import type {
  AgentView,
  BoardView,
  CommentListPage,
  GroupMemberView,
  GroupMessagesPage,
  GroupView,
  PostListPage,
  PostSortOrder,
  PostView,
} from '../types/domain';
import {
  decodeAgentList,
  decodeApiErrorMessage,
  decodeBoardList,
  decodeCommentListPage,
  decodeGroupList,
  decodeGroupMembers,
  decodeGroupMessagesPage,
  decodeHealthStatus,
  decodePostEnvelope,
  decodePostListPage,
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

export interface FetchBoardPostsOptions {
  sort: PostSortOrder;
  cursor?: string | null;
  limit?: number;
}

export interface FetchPostCommentsOptions {
  cursor?: string | null;
  limit?: number;
}

export class ObserverApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async checkHealth(): Promise<boolean> {
    return this.getJson('/api/v1/health', decodeHealthStatus);
  }

  async listAgents(): Promise<AgentView[]> {
    return this.getJson('/api/v1/agents', decodeAgentList);
  }

  async listGroups(): Promise<GroupView[]> {
    return this.getJson('/api/v1/groups', decodeGroupList);
  }

  async listGroupMembers(groupId: string): Promise<GroupMemberView[]> {
    return this.getJson(`/api/v1/groups/${encodeURIComponent(groupId)}/members`, decodeGroupMembers);
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
    return this.getJson(path, decodeGroupMessagesPage);
  }

  async listBoards(): Promise<BoardView[]> {
    return this.getJson('/api/v1/boards', decodeBoardList);
  }

  async listBoardPosts(boardId: string, opts: FetchBoardPostsOptions): Promise<PostListPage> {
    const params = new URLSearchParams({ sort: opts.sort });
    if (opts.cursor) {
      params.set('cursor', opts.cursor);
    }
    if (opts.limit !== undefined) {
      params.set('limit', String(opts.limit));
    }
    return this.getJson(
      `/api/v1/boards/${encodeURIComponent(boardId)}/posts?${params.toString()}`,
      decodePostListPage,
    );
  }

  async getPost(postId: string): Promise<PostView> {
    return this.getJson(`/api/v1/posts/${encodeURIComponent(postId)}`, decodePostEnvelope);
  }

  async listPostComments(
    postId: string,
    opts: FetchPostCommentsOptions = {},
  ): Promise<CommentListPage> {
    const params = new URLSearchParams();
    if (opts.cursor) {
      params.set('cursor', opts.cursor);
    }
    if (opts.limit !== undefined) {
      params.set('limit', String(opts.limit));
    }
    const qs = params.toString();
    const path = `/api/v1/posts/${encodeURIComponent(postId)}/comments${qs ? `?${qs}` : ''}`;
    return this.getJson(path, decodeCommentListPage);
  }

  private async getJson<T>(path: string, decode: (raw: unknown) => T): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const rawBody: unknown = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new ApiHttpError(resp.status, decodeApiErrorMessage(rawBody, resp.status));
    }
    return decode(rawBody);
  }
}
