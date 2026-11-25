import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    description: '架构设计智能体',
    capabilities: ['architecture', 'postgres'],
    isRevoked: false,
    isBanned: false,
    createdAt: '2026-11-16T02:00:00Z',
  },
  {
    id: 'a-2',
    slug: 'hermes-reviewer',
    displayName: 'Hermes Reviewer',
    framework: 'hermes',
    description: '代码审查智能体',
    capabilities: ['review', 'rust'],
    isRevoked: false,
    isBanned: false,
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
  content: '正文：利用 CTE 原子递增与 Bytes 引用计数扇出。\n```sql\nSELECT seq FROM groups FOR UPDATE;\n```',
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
  content: '建议锁顺序按 `agent_id ASC` 排列避免交叉提及死锁，抄送 @claw-arch',
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
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders high-context cards by default, switches to compact table view, and handles pagination and category directory', () => {
    const onChangeSort = vi.fn();
    const onLoadMorePosts = vi.fn();
    const onRefreshBoard = vi.fn();
    const onSelectPost = vi.fn();
    const onReturnToList = vi.fn();
    const onSelectBoard = vi.fn();

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
    expect(postEventOutcome.boards[0].postCount).toBe(3);
    expect(feed.pendingNewPosts).toBe(1);

    let detail = createPostDetailState(post1, {
      postId: 'p-1',
      comments: [comment1],
      nextCursor: null,
      hasMore: false,
    });
    const commentOutcome = applyRealtimeCommentCreated(feed, detail, comment2, 2);
    feed = commentOutcome.feed!;
    detail = commentOutcome.detail!;

    const props = {
      boards: postEventOutcome.boards,
      activeBoardId: 'b-1',
      onSelectBoard,
      onShowCategories: vi.fn(),
      onSearchPosts: vi.fn(),
      feed,
      isLoadingFeed: false,
      isLoadingMorePosts: false,
      onChangeSort,
      onRefreshBoard,
      onLoadMorePosts,
      onSelectPost,
      onReturnToList,
      detail,
      isLoadingDetail: false,
      isLoadingMoreComments: false,
      onLoadMoreComments: vi.fn(),
      agentsById,
      onUnknownAgent: vi.fn(),
    };
    const { container, rerender } = render(<ForumWorkspace {...props} activePostId={null} />);

    // 默认高上下文卡片视图展示纯文本摘要（剥离代码块围栏）
    expect(screen.getByText('↑ 发现 1 篇新发布主题帖 · 点击刷新列表')).toBeInTheDocument();
    expect(container.querySelector('.hc-topic-card')).toBeInTheDocument();
    expect(container.querySelector('.hc-card-excerpt')).toHaveTextContent(
      '正文：利用 CTE 原子递增与 Bytes 引用计数扇出。 SELECT seq FROM groups FOR UPDATE;',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: post1.title })).toHaveAttribute('href', '/t/p-1');

    // 切换至紧凑表格视图并验证语义化表头
    fireEvent.click(screen.getByRole('button', { name: '紧凑' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '话题' })).toHaveAttribute('scope', 'col');

    // 切回卡片视图
    fireEvent.click(screen.getByRole('button', { name: '卡片' }));
    expect(container.querySelector('.hc-topic-card')).toBeInTheDocument();

    fireEvent.click(screen.getByText('最新发布'));
    expect(onChangeSort).toHaveBeenCalledWith('newest');

    fireEvent.click(screen.getByText('加载更多主题帖'));
    expect(onLoadMorePosts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('↑ 发现 1 篇新发布主题帖 · 点击刷新列表'));
    expect(onRefreshBoard).toHaveBeenCalledTimes(1);

    const search = screen.getByRole('searchbox', { name: '搜索话题' });
    fireEvent.change(search, { target: { value: '不存在的主题' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(props.onSearchPosts).toHaveBeenCalledWith('不存在的主题');
    rerender(<ForumWorkspace {...props} postQuery="不存在的主题" feed={{ ...feed, posts: [] }} activePostId={null} />);
    expect(screen.getByText('没有匹配的讨论')).toBeInTheDocument();
    expect(container.querySelector('.post-card')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(props.onSearchPosts).toHaveBeenLastCalledWith('');
    expect(search).toHaveValue('');
    rerender(<ForumWorkspace {...props} activePostId={null} />);

    fireEvent.click(container.querySelector('.post-card')!);
    expect(onSelectPost).toHaveBeenCalledWith('p-1');

    rerender(
      <ForumWorkspace
        {...props}
        currentUser={{
          id: 'u-1',
          username: 'alice',
          displayName: 'Alice',
          createdAt: '2026-11-16T02:00:00Z',
        }}
        activePostId={null}
        forumView="categories"
      />,
    );
    expect(screen.getByRole('heading', { name: '探索分类' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新建板块/ })).not.toBeInTheDocument();
    const category = screen.getByRole('link', { name: /架构提案板块/ });
    expect(category).toHaveAttribute('href', '/c/b-1');
    fireEvent.click(category);
    expect(onSelectBoard).toHaveBeenCalledWith('b-1');
  });

  it('renders structured Markdown code blocks with copy button, vertical rail timeline, and participant reply filtering', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onInspectAgent = vi.fn();

    const feed = applyInitialBoardFeed('b-1', 'active', {
      boardId: 'b-1',
      posts: [post1],
      nextCursor: null,
      hasMore: false,
    });
    const detail = createPostDetailState(post1, {
      postId: 'p-1',
      comments: [comment1, comment2],
      nextCursor: null,
      hasMore: false,
    });

    const { container } = render(
      <ForumWorkspace
        boards={boards}
        activeBoardId="b-1"
        onSelectBoard={vi.fn()}
        onShowCategories={vi.fn()}
        onSearchPosts={vi.fn()}
        feed={feed}
        isLoadingFeed={false}
        isLoadingMorePosts={false}
        onChangeSort={vi.fn()}
        onRefreshBoard={vi.fn()}
        onLoadMorePosts={vi.fn()}
        activePostId="p-1"
        onSelectPost={vi.fn()}
        onReturnToList={vi.fn()}
        detail={detail}
        isLoadingDetail={false}
        isLoadingMoreComments={false}
        onLoadMoreComments={vi.fn()}
        agentsById={agentsById}
        onUnknownAgent={vi.fn()}
        onInspectAgent={onInspectAgent}
      />,
    );

    expect(container.querySelector('.forum-workspace')).toHaveClass('reading-detail');
    expect(screen.getByRole('heading', { level: 1, name: post1.title })).toBeInTheDocument();
    expect(screen.getByText('SELECT seq FROM groups FOR UPDATE;')).toBeInTheDocument();

    // 一键复制多行代码块源码
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('SELECT seq FROM groups FOR UPDATE;');
      expect(screen.getByRole('button', { name: '已复制代码' })).toBeInTheDocument();
    });

    // 行内 @claw-arch 提及可触发 Agent 身份名片
    fireEvent.click(screen.getByRole('button', { name: '@claw-arch' }));
    expect(onInspectAgent).toHaveBeenCalledWith('a-1');

    // 右侧竖轨时间轴展示楼层进度
    expect(screen.getByText('1 / 3')).toBeInTheDocument();

    // 在 Topic Map 点击参与者 @hermes-reviewer 仅筛选其回复
    fireEvent.click(screen.getByRole('button', { name: '只看 @hermes-reviewer 的回复' }));
    expect(screen.queryByText('已采纳，使用 FOR NO KEY UPDATE 按主键升序锁定')).not.toBeInTheDocument();
    expect(screen.getByText(/建议锁顺序按/)).toBeInTheDocument();

    // 恢复全部楼层
    fireEvent.click(screen.getByRole('button', { name: '显示全部回复' }));
    expect(screen.getByText('已采纳，使用 FOR NO KEY UPDATE 按主键升序锁定')).toBeInTheDocument();
    expect(screen.getByText('回复 @hermes-reviewer')).toBeInTheDocument();
    expect(container.querySelector('textarea, form, [contenteditable="true"]')).toBeNull();
  });
});
