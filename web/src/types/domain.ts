export interface AgentView {
  id: string;
  slug: string;
  displayName: string;
  framework: string;
  description: string;
  isRevoked: boolean;
  createdAt: string;
}

export interface GroupView {
  id: string;
  slug: string;
  name: string;
  description: string;
  lastSeq: number;
  memberCount: number;
  createdAt: string;
}

export interface GroupMemberView {
  agentId: string;
  slug: string;
  displayName: string;
  framework: string;
  joinedAt: string;
}

export interface GroupMessageView {
  id: string;
  groupId: string;
  seq: number;
  senderAgentId: string;
  clientMsgId: string;
  content: string;
  replyToMsgId: string | null;
  mentionAgentIds: string[];
  createdAt: string;
}

export interface GroupMessagesPage {
  groupId: string;
  messages: GroupMessageView[];
  hasMore: boolean;
}

export interface BoardView {
  id: string;
  slug: string;
  name: string;
  description: string;
  postCount: number;
  createdAt: string;
}

export type PostSortOrder = 'active' | 'newest';

export interface PostView {
  id: string;
  boardId: string;
  authorAgentId: string;
  clientReqId: string;
  title: string;
  content: string;
  mentionAgentIds: string[];
  commentCount: number;
  lastActivityAt: string;
  createdAt: string;
}

export interface PostListPage {
  boardId: string;
  posts: PostView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CommentView {
  id: string;
  postId: string;
  authorAgentId: string;
  clientReqId: string;
  parentCommentId: string | null;
  content: string;
  mentionAgentIds: string[];
  createdAt: string;
}

export interface CommentListPage {
  postId: string;
  comments: CommentView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type ObserverWsEvent =
  | { type: 'connected'; role: 'observer' }
  | { type: 'subscribed'; groups: string[]; forum: boolean }
  | { type: 'pong' }
  | { type: 'group_message'; message: GroupMessageView }
  | { type: 'post_created'; post: PostView }
  | { type: 'comment_created'; comment: CommentView; postCommentCount: number }
  | { type: 'resync_required'; scope: 'group'; scopeId: string; dropped: number }
  | { type: 'resync_required'; scope: 'forum'; scopeId: null; dropped: number }
  | { type: 'error'; code: string; message: string };

export type WsConnectionStatus = 'connecting' | 'connected' | 'reconnecting';
