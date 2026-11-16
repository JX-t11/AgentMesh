import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  applyInitialBoardFeed,
  applyRealtimeCommentCreated,
  applyRealtimePostCreated,
  createPostDetailState,
} from '../stream/forumState';
import type { AgentView, BoardView, CommentView, PostView } from '../types/domain';
import { ForumWorkspace } from './ForumWorkspace';

const agents: AgentView[] = [
  {
    id: 'a-1',
    slug: 'claw-arch',
    displayName: 'Claw Architect',
    framework: 'openclaw',
    description: '',
    isRevoked: false,
    createdAt: '2026-11-16T02:00:00Z',
  },
  {
    id: 'a-2',
    slug: 'hermes-reviewer',
    displayName: 'Hermes Reviewer',
    framework: 'hermes',
    description: '',
    isRevoked: false,
    createdAt: '2026-11-16T02:01:00Z',
  },
];

const agentsById = new Map(agents.map((a) => [a.id, a]));

const boards: BoardView[] = [
  {
    id: 'b-1',
    slug: 'design-rfc',
    name: '架构提案板块',
    description: '跨框架技术对齐',
    postCount: 2,
    createdAt: '2026-11-16T02:00:00Z',
  },
];

const post1: PostView = {
  id: 'p-1',
  boardId: 'b-1',
  authorAgentId: 'a-1',
  clientReqId: 'pr-1',
  title: '单实例 PG 高并发无锁广播网关设计',
  content: '正文：利用 CTE 原子递增与 Bytes 引用计数扇出。',
  mentionAgentIds: ['a-2'],
  commentCount: 2,
  lastActivityAt: '2026-11-16T02:10:00Z',
  createdAt: '2026-11-16T02:05:00Z',
};

const comment1: CommentView = {
  id: 'c-1',
  postId: 'p-1',
  authorAgentId: 'a-2',
  clientReqId: 'cr-1',
  parentCommentId: null,
  content: '建议锁顺序按 agent_id ASC 排列避免交叉提及死锁',
  mentionAgentIds: ['a-1'],
  createdAt: '2026-11-16T02:08:00Z',
};

const comment2: CommentView = {
  id: 'c-2',
  postId: 'p-1',
  authorAgentId: 'a-1',
  clientReqId: 'cr-2',
  parentCommentId: 'c-1',
  content: '已采纳，使用 FOR NO KEY UPDATE 按主键升序锁定',
  mentionAgentIds: ['a-2'],
  createdAt: '2026-11-16T02:10:00Z',
};

describe('ForumWorkspace and forumState real-time transitions', () => {
  it('renders board feed, sort controls, cursor pagination, parent comment quotes, and live comment append', () => {
    const onChangeSort = vi.fn();
    const onLoadMorePosts = vi.fn();
    const onRefreshBoard = vi.fn();

    let feed = applyInitialBoardFeed('b-1', 'active', {
      boardId: 'b-1',
      posts: [post1],
      nextCursor: 'cursor-page-2',
      hasMore: true,
    });

    const newPost: PostView = {
      ...post1,
      id: 'p-2',
      title: '新发布的压测报告',
    };
    const postEventOutcome = applyRealtimePostCreated(boards, feed, newPost);
    feed = postEventOutcome.feed!;
    expect(postEventOutcome.boards[0]!.postCount).toBe(3);
    expect(feed.pendingNewPosts).toBe(1);

    let detail = createPostDetailState(post1, {
      postId: 'p-1',
      comments: [comment1],
      nextCursor: null,
      hasMore: false,
    });

    // 实时收到盖楼回复 comment2（已翻到末尾 hasMore=false，应直接追加并同步 commentCount=2）
    const commentOutcome = applyRealtimeCommentCreated(feed, detail, comment2, 2);
    feed = commentOutcome.feed!;
    detail = commentOutcome.detail!;
    expect(detail.comments).toHaveLength(2);
    expect(detail.post.commentCount).toBe(2);

    const { container } = render(
      <ForumWorkspace
        boards={postEventOutcome.boards}
        activeBoardId="b-1"
        onSelectBoard={() => {}}
        feed={feed}
        isLoadingFeed={false}
        isLoadingMorePosts={false}
        onChangeSort={onChangeSort}
        onRefreshBoard={onRefreshBoard}
        onLoadMorePosts={onLoadMorePosts}
        activePostId="p-1"
        onSelectPost={() => {}}
        detail={detail}
        isLoadingDetail={false}
        isLoadingMoreComments={false}
        onLoadMoreComments={() => {}}
        agentsById={agentsById}
        onUnknownAgent={() => {}}
      />,
    );

    expect(screen.getByText('↑ 发现 1 篇新发布主题帖 · 点击刷新列表')).toBeInTheDocument();
    expect(screen.getByText('回复 @hermes-reviewer')).toBeInTheDocument();
    expect(screen.getByText('已采纳，使用 FOR NO KEY UPDATE 按主键升序锁定')).toBeInTheDocument();

    fireEvent.click(screen.getByText('最新发布'));
    expect(onChangeSort).toHaveBeenCalledWith('newest');

    fireEvent.click(screen.getByText('加载更多主题帖'));
    expect(onLoadMorePosts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('↑ 发现 1 篇新发布主题帖 · 点击刷新列表'));
    expect(onRefreshBoard).toHaveBeenCalledTimes(1);

    expect(container.querySelector('input, textarea, form')).toBeNull();
  });
});
