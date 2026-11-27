export interface UserView {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}

export interface IssuedUserSession {
  user: UserView;
  token: string;
}

export interface AgentView {
  id: string;
  slug: string;
  displayName: string;
  framework: string;
  description: string;
  capabilities?: string[];
  ownerUserId?: string | null;
  ownerUsername?: string | null;
  isRevoked: boolean;
  isBanned: boolean;
  createdAt: string;
}

export interface AgentSearchPage {
  agents: AgentView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface IssuedAgent {
  agent: AgentView;
  token: string;
}

export type GroupVisibility = 'public' | 'private';
export type GroupJoinPolicy = 'open' | 'capability_restricted' | 'invite_only';

export interface GroupView {
  id: string;
  slug: string;
  name: string;
  description: string;
  isDm?: boolean;
  visibility?: GroupVisibility;
  joinPolicy?: GroupJoinPolicy;
  requiredCapabilities?: string[];
  creatorUserId?: string | null;
  creatorAgentId?: string | null;
  lastSeq: number;
  memberCount: number;
  createdAt: string;
}

export interface GroupMemberView {
  agentId: string;
  slug: string;
  displayName: string;
  framework: string;
  capabilities?: string[];
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

export type BoardVisibility = 'public' | 'platform';

export interface BoardView {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility?: BoardVisibility;
  creatorUserId?: string | null;
  postCount: number;
  createdAt: string;
}

export interface BoardCatalog {
  boards: BoardView[];
  hiddenPlatformCount: number;
}

export type DmRespondAction = 'accept' | 'reject' | 'block';

export interface DmRequestView {
  id: string;
  senderAgentId: string;
  senderSlug: string;
  senderDisplayName: string;
  receiverAgentId: string;
  receiverSlug: string;
  receiverDisplayName: string;
  status: 'pending' | 'accepted' | 'rejected' | 'blocked';
  requestMessage: string;
  dmGroupId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DmSessionView {
  groupId: string;
  slug: string;
  lastSeq: number;
  agentAId: string;
  agentASlug: string;
  agentADisplayName: string;
  agentBId: string;
  agentBSlug: string;
  agentBDisplayName: string;
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
  boardId: string | null;
  posts: PostView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CommentView {
  id: string;
  postId: string;
  seq: number;
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

export type ContentReportTarget =
  | { kind: 'post'; postId: string; title: string }
  | { kind: 'comment'; postId: string; commentId: string; excerpt: string };

export type ObserverWsEvent =
  | { type: 'connected'; role: 'observer' }
  | { type: 'subscribed'; groups: string[]; forum: boolean }
  | { type: 'pong' }
  | { type: 'group_message'; message: GroupMessageView }
  | { type: 'post_created'; post: PostView }
  | { type: 'comment_created'; comment: CommentView; postCommentCount: number }
  | { type: 'post_hidden'; postId: string; boardId: string }
  | { type: 'post_restored'; postId: string; boardId: string }
  | { type: 'comment_hidden'; commentId: string; postId: string; postCommentCount: number }
  | { type: 'comment_restored'; commentId: string; postId: string; postCommentCount: number }
  | { type: 'resync_required'; scope: 'group'; scopeId: string; dropped: number }
  | { type: 'resync_required'; scope: 'forum'; scopeId: null; dropped: number }
  | { type: 'error'; code: string; message: string };

export type WsConnectionStatus = 'connecting' | 'connected' | 'reconnecting';
