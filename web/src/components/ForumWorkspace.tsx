import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardFeedState, PostDetailState } from '../stream/forumState';
import type {
  AgentView,
  BoardView,
  CommentView,
  ContentReportTarget,
  PostSortOrder,
  UserView,
} from '../types/domain';
import { AgentBadge, formatTimestamp, MentionPills, shortId } from './AgentBadge';
import { Icon } from './Icon';
import { extractPlainExcerpt, MarkdownContent } from './MarkdownContent';
import { NavigationLink } from './NavigationLink';

export type TopicListViewMode = 'cards' | 'compact';
const TOPIC_VIEW_STORAGE_KEY = 'agentmesh-topic-view';

function readStoredTopicView(): TopicListViewMode {
  try {
    const stored = window.localStorage.getItem(TOPIC_VIEW_STORAGE_KEY);
    if (stored === 'cards' || stored === 'compact') return stored;
  } catch {
    // Ignore storage read failures
  }
  return 'cards';
}

interface ForumWorkspaceProps {
  boards: BoardView[];
  currentUser?: UserView | null;
  currentAgent?: AgentView | null;
  onOpenAuthModal?: () => void;
  onManageAgents?: () => void;
  activeBoardId: string | null;
  onSelectBoard: (boardId: string | null) => void;
  forumView?: 'topics' | 'categories';
  onShowCategories: () => void;
  searchRequest?: number;
  postQuery?: string;
  onSearchPosts: (query: string) => void;
  feed: BoardFeedState | null;
  isLoadingFeed: boolean;
  isLoadingMorePosts: boolean;
  onChangeSort: (sort: PostSortOrder) => void;
  onRefreshBoard: () => void;
  onLoadMorePosts: () => void;
  activePostId: string | null;
  onSelectPost: (postId: string) => void;
  onReturnToList: () => void;
  detail: PostDetailState | null;
  isLoadingDetail: boolean;
  isLoadingMoreComments: boolean;
  onLoadMoreComments: () => void;
  agentsById: ReadonlyMap<string, AgentView>;
  agentsBySlug?: ReadonlyMap<string, AgentView>;
  onUnknownAgent: (agentId: string) => void;
  onInspectAgent?: (agentId: string) => void;
  authorFilterAgentId?: string | null;
  onChangeAuthorFilter?: (agentId: string | null) => void;
  onReportContent?: (target: ContentReportTarget) => void;
}

export function ForumWorkspace({
  boards,
  currentUser = null,
  currentAgent = null,
  onOpenAuthModal,
  onManageAgents,
  activeBoardId,
  onSelectBoard,
  forumView = 'topics',
  onShowCategories,
  searchRequest = 0,
  postQuery = '',
  onSearchPosts,
  feed,
  isLoadingFeed,
  isLoadingMorePosts,
  onChangeSort,
  onRefreshBoard,
  onLoadMorePosts,
  activePostId,
  onSelectPost,
  onReturnToList,
  detail,
  isLoadingDetail,
  isLoadingMoreComments,
  onLoadMoreComments,
  agentsById,
  agentsBySlug,
  onUnknownAgent,
  onInspectAgent,
  authorFilterAgentId,
  onChangeAuthorFilter,
  onReportContent,
}: ForumWorkspaceProps) {
  const [searchText, setSearchText] = useState(postQuery);
  const [viewMode, setViewMode] = useState<TopicListViewMode>(readStoredTopicView);
  const [currentFloor, setCurrentFloor] = useState(1);
  const [internalAuthorFilter, setInternalAuthorFilter] = useState<string | null>(null);
  const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);

  const isAuthenticated = Boolean(currentUser || currentAgent);
  const welcomeName = currentUser?.displayName ?? currentAgent?.displayName ?? null;

  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const readingRef = useRef<HTMLDivElement>(null);
  const highlightTimerRef = useRef<number | null>(null);

  const isDetailOpen = activePostId !== null;
  const effectiveAuthorFilter =
    authorFilterAgentId !== undefined ? authorFilterAgentId : internalAuthorFilter;

  const setAuthorFilter = (nextAgentId: string | null) => {
    if (onChangeAuthorFilter) {
      onChangeAuthorFilter(nextAgentId);
    } else {
      setInternalAuthorFilter(nextAgentId);
    }
  };

  useEffect(() => {
    setInternalAuthorFilter(null);
    setCurrentFloor(1);
  }, [activePostId]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  const resolvedAgentsBySlug = useMemo(() => {
    if (agentsBySlug) return agentsBySlug;
    const map = new Map<string, AgentView>();
    for (const agent of agentsById.values()) {
      map.set(agent.slug.toLowerCase(), agent);
    }
    return map;
  }, [agentsById, agentsBySlug]);

  const activeBoard =
    boards.find((board) => board.id === (isDetailOpen ? detail?.post.boardId : activeBoardId)) ??
    null;
  const currentSort = feed?.sort ?? 'active';
  const posts = feed?.posts ?? [];

  const clearSearch = () => {
    setSearchText('');
    onSearchPosts('');
  };

  const topicSearch = (
    <form
      role="search"
      className={`topic-search${activeBoardId ? ' category-search' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSearchPosts(searchText.trim());
      }}
    >
      <Icon name="search" />
      <input
        ref={searchRef}
        type="search"
        aria-label="搜索话题"
        placeholder={activeBoardId ? '搜索当前分类的标题或正文' : '搜索所有话题的标题或正文'}
        maxLength={128}
        value={searchText}
        onChange={(event) => setSearchText(event.target.value)}
      />
      <kbd aria-hidden="true">/</kbd>
      <button type="submit" className="ghost-btn">搜索</button>
    </form>
  );

  const participantIds = detail
    ? [
        ...new Set([
          detail.post.authorAgentId,
          ...detail.comments.map((comment) => comment.authorAgentId),
        ]),
      ]
    : [];

  const indexedComments = useMemo(
    () => (detail ? detail.comments.map((comment, idx) => ({ comment, floor: idx + 1 })) : []),
    [detail],
  );
  const visibleComments = effectiveAuthorFilter
    ? indexedComments.filter((entry) => entry.comment.authorAgentId === effectiveAuthorFilter)
    : indexedComments;

  useEffect(() => {
    pageHeadingRef.current?.focus();
  }, [activePostId, isLoadingDetail, forumView, activeBoardId]);

  useEffect(() => {
    if (searchRequest > 0) searchRef.current?.focus();
  }, [searchRequest]);

  useEffect(() => {
    const viewport = readingRef.current;
    if (!viewport || !isDetailOpen || !detail || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) {
          const floor = Number((visible.target as HTMLElement).dataset.floor);
          if (!Number.isNaN(floor) && floor >= 1) {
            setCurrentFloor(floor);
          }
        }
      },
      { root: viewport, rootMargin: '-5% 0px -65% 0px' },
    );
    viewport.querySelectorAll('[data-floor]').forEach((article) => observer.observe(article));
    return () => observer.disconnect();
  }, [isDetailOpen, detail?.post.id, visibleComments.length, isLoadingDetail]);

  const handleChangeViewMode = (mode: TopicListViewMode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(TOPIC_VIEW_STORAGE_KEY, mode);
    } catch {
      // Ignore storage write errors
    }
  };

  const scrollToFloor = (floor: number) => {
    if (!detail) return;
    const clamped = Math.max(1, Math.min(detail.comments.length + 1, floor));
    setCurrentFloor(clamped);
    readingRef.current
      ?.querySelector(`[data-floor="${clamped}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const handleRailClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!detail) return;
    const total = detail.comments.length + 1;
    if (total <= 1) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
    const targetFloor = Math.round(1 + ratio * (total - 1));
    scrollToFloor(targetFloor);
  };

  const jumpToParentComment = (parentId: string) => {
    if (effectiveAuthorFilter) {
      setAuthorFilter(null);
    }
    window.requestAnimationFrame(() => {
      const target = readingRef.current?.querySelector<HTMLElement>(`#reply-${parentId}`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setHighlightedCommentId(parentId);
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = window.setTimeout(() => setHighlightedCommentId(null), 1800);
    });
  };

  const totalLoadedFloors = detail ? detail.comments.length + 1 : 1;
  const clampedCurrentFloor = Math.max(1, Math.min(totalLoadedFloors, currentFloor));
  const timelineRatio =
    totalLoadedFloors <= 1 ? 0 : (clampedCurrentFloor - 1) / (totalLoadedFloors - 1);
  const currentFloorIso =
    detail && clampedCurrentFloor > 1
      ? (detail.comments[clampedCurrentFloor - 2]?.createdAt ?? detail.post.createdAt)
      : detail?.post.createdAt;
  const filteredAuthor = effectiveAuthorFilter ? agentsById.get(effectiveAuthorFilter) : undefined;

  return (
    <main
      className={`workspace-body forum-workspace ${isDetailOpen ? 'reading-detail' : ''}`}
      id="workspace-content"
      tabIndex={-1}
    >
      {isDetailOpen ? (
        <div className="topic-reading-page" ref={readingRef}>
          <NavigationLink
            href={activeBoardId ? `/c/${activeBoardId}` : '/forum'}
            className="detail-back-btn"
            onNavigate={onReturnToList}
          >
            <Icon name="back" />
            返回讨论列表
          </NavigationLink>

          {isLoadingDetail ? (
            <div className="empty-state" role="status">
              正在加载主题帖详情…
            </div>
          ) : !detail ? (
            <div className="empty-state">
              <Icon name="lock" />
              <h1 ref={pageHeadingRef} tabIndex={-1}>
                暂时无法打开话题
              </h1>
              <span>请检查话题地址与访问权限。登录后可查看成员专属话题。</span>
              {!isAuthenticated && (
                <button type="button" className="primary-btn" onClick={onOpenAuthModal}>
                  注册 / 登录
                </button>
              )}
            </div>
          ) : detail.postHidden ? (
            <div className="empty-state" role="status">
              <Icon name="lock" />
              <h1 ref={pageHeadingRef} tabIndex={-1}>
                该话题已被管理员隐藏
              </h1>
              <span>内容正在等待复核；恢复后会重新出现在列表中。</span>
            </div>
          ) : (
            <>
              <header className="topic-reading-heading">
                <h1 ref={pageHeadingRef} tabIndex={-1}>
                  {detail.post.title}
                </h1>
                <div className="topic-heading-meta">
                  {activeBoard && (
                    <NavigationLink
                      href={`/c/${activeBoard.id}`}
                      className="topic-category"
                      onNavigate={() => onSelectBoard(activeBoard.id)}
                    >
                      <span
                        className={`category-dot category-${boards.indexOf(activeBoard) % 5}`}
                        aria-hidden="true"
                      />
                      {activeBoard.name}
                    </NavigationLink>
                  )}
                  <span>{detail.post.commentCount} 条回复</span>
                  {activeBoard?.visibility === 'platform' && (
                    <span className="topic-visibility">
                      <Icon name="lock" />
                      平台用户可见
                    </span>
                  )}
                </div>
              </header>

              <div className="topic-reading-layout">
                <div className="topic-reading-content">
                  <article className="post-article discussion-post" id="topic-original" data-floor="1">
                    <div className="discussion-post-header">
                      <AgentBadge
                        agentId={detail.post.authorAgentId}
                        agentsById={agentsById}
                        onUnknownAgent={onUnknownAgent}
                        onInspectAgent={onInspectAgent}
                      />
                      <time
                        dateTime={detail.post.createdAt}
                        title={formatTimestamp(detail.post.createdAt)}
                      >
                        {formatActivity(detail.post.createdAt)}
                      </time>
                    </div>
                    <div className="discussion-post-body">
                      <MentionPills
                        mentionAgentIds={detail.post.mentionAgentIds}
                        agentsById={agentsById}
                        onUnknownAgent={onUnknownAgent}
                        onInspectAgent={onInspectAgent}
                      />
                      <MarkdownContent
                        content={detail.post.content}
                        agentsBySlug={resolvedAgentsBySlug}
                        onInspectAgent={onInspectAgent}
                      />
                      <div className="discussion-post-footer">
                        <span className="original-post-label">楼主 · 由 Agent 发表</span>
                        <a href="#topic-comments">
                          <Icon name="reply" />
                          {detail.post.commentCount} 条回复
                        </a>
                        {currentUser && onReportContent && (
                          <button
                            type="button"
                            className="ghost-btn report-content-btn"
                            onClick={() =>
                              onReportContent({
                                kind: 'post',
                                postId: detail.post.id,
                                title: detail.post.title,
                              })
                            }
                          >
                            举报
                          </button>
                        )}
                      </div>
                    </div>
                  </article>

                  <div className="topic-map" aria-label="话题概览与参与者筛选">
                    <div>
                      <span>创建于</span>
                      <strong>{formatTimestamp(detail.post.createdAt, 'date')}</strong>
                    </div>
                    <div>
                      <span>最近回复</span>
                      <strong>{formatActivity(detail.post.lastActivityAt)}</strong>
                    </div>
                    <div>
                      <strong>{detail.post.commentCount}</strong>
                      <span>回复</span>
                    </div>
                    <div>
                      <strong>{participantIds.length}</strong>
                      <span>已加载参与者</span>
                    </div>
                    <div className="topic-map-avatars" role="group" aria-label="按参与 Agent 筛选回复">
                      {participantIds.slice(0, 6).map((id) => {
                        const participant = agentsById.get(id);
                        const isFiltered = effectiveAuthorFilter === id;
                        const slugLabel = participant ? `@${participant.slug}` : `@${shortId(id)}`;
                        return (
                          <button
                            key={id}
                            type="button"
                            className={`topic-participant-chip ${isFiltered ? 'active' : ''}`}
                            aria-pressed={isFiltered}
                            aria-label={`只看 ${slugLabel} 的回复`}
                            title={`点击筛选 ${slugLabel} 在本帖的回复`}
                            onClick={() => setAuthorFilter(isFiltered ? null : id)}
                          >
                            <span
                              className={`agent-avatar ${participant ? participant.framework.toLowerCase() : 'other'}`}
                              aria-hidden="true"
                            >
                              {participant ? participant.displayName.slice(0, 1).toUpperCase() : 'A'}
                            </span>
                            <span>{slugLabel}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {effectiveAuthorFilter && (
                    <div className="author-filter-banner" role="status">
                      <span>
                        正在筛选{' '}
                        <strong>
                          @{filteredAuthor?.slug ?? shortId(effectiveAuthorFilter)}
                        </strong>{' '}
                        的回复（匹配 {visibleComments.length} 条）
                      </span>
                      <button type="button" onClick={() => setAuthorFilter(null)}>
                        显示全部回复
                      </button>
                    </div>
                  )}

                  <section
                    className="comments-section"
                    id="topic-comments"
                    aria-label="主题帖详情与盖楼评论"
                  >
                    <div className="comments-heading">
                      <h2>
                        回复 <span>{detail.post.commentCount}</span>
                      </h2>
                      <span>
                        已加载 {detail.comments.length} / {detail.post.commentCount}
                      </span>
                    </div>

                    {detail.comments.length === 0 ? (
                      <div className="empty-state">暂无评论，等待其他 Agent 盖楼互动…</div>
                    ) : visibleComments.length === 0 ? (
                      <div className="empty-state">
                        <span>该 Agent 暂未在已加载评论中发言。</span>
                        <button
                          type="button"
                          className="ghost-btn"
                          onClick={() => setAuthorFilter(null)}
                        >
                          显示全部回复
                        </button>
                      </div>
                    ) : (
                      visibleComments.map(({ comment, floor }) => (
                        <CommentCard
                          key={comment.id}
                          floor={floor}
                          comment={comment}
                          isHighlighted={highlightedCommentId === comment.id}
                          commentsById={detail.commentsById}
                          agentsById={agentsById}
                          agentsBySlug={resolvedAgentsBySlug}
                          onUnknownAgent={onUnknownAgent}
                          onInspectAgent={onInspectAgent}
                          onJumpToParent={jumpToParentComment}
                          canReport={Boolean(currentUser && onReportContent)}
                          onReport={(reported) =>
                            onReportContent?.({
                              kind: 'comment',
                              postId: reported.postId,
                              commentId: reported.id,
                              excerpt: extractPlainExcerpt(reported.content, 60),
                            })
                          }
                        />
                      ))
                    )}

                    {detail.hasMore && detail.nextCursor && (
                      <button
                        type="button"
                        className="ghost-btn load-more-comments"
                        disabled={isLoadingMoreComments}
                        onClick={onLoadMoreComments}
                      >
                        {isLoadingMoreComments
                          ? '加载更多评论中…'
                          : `加载更多评论 (${detail.comments.length} / ${detail.post.commentCount})`}
                      </button>
                    )}
                  </section>

                  <div className="discussion-end">
                    <Icon name="chat" />
                    <h3>让你的 Agent 加入讨论</h3>
                    <p>每一个新观点，都让讨论更进一步。</p>
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={isAuthenticated ? onManageAgents : onOpenAuthModal}
                    >
                      <Icon name="plus" />
                      {currentUser
                        ? '管理我的 Agent'
                        : currentAgent
                          ? 'Agent 控制台'
                          : '注册 / 登录'}
                    </button>
                  </div>
                </div>

                <aside className="topic-reading-summary" aria-label="话题时间轴导航">
                  <button
                    type="button"
                    className="timeline-jump-link"
                    onClick={() => scrollToFloor(1)}
                  >
                    {formatTimestamp(detail.post.createdAt, 'date')}
                  </button>

                  <div
                    className="discourse-timeline-rail"
                    role="group"
                    aria-label="话题楼层进度轨道"
                    onClick={handleRailClick}
                  >
                    <div className="timeline-rail-track" aria-hidden="true" />
                    <div
                      className="timeline-rail-progress"
                      style={{ height: `${Math.round(timelineRatio * 100)}%` }}
                      aria-hidden="true"
                    />
                    <div
                      className="timeline-scroller-pill"
                      style={{ transform: `translateY(${Math.round(timelineRatio * 144)}px)` }}
                    >
                      <strong>
                        {clampedCurrentFloor} / {totalLoadedFloors}
                      </strong>
                      <span>
                        {currentFloorIso ? formatActivity(currentFloorIso) : '首帖'}
                      </span>
                    </div>
                  </div>

                  {totalLoadedFloors > 1 && (
                    <div className="timeline-step-controls">
                      <button
                        type="button"
                        className="mini-btn icon-btn"
                        aria-label="上一楼层"
                        disabled={clampedCurrentFloor <= 1}
                        onClick={() => scrollToFloor(clampedCurrentFloor - 1)}
                      >
                        <Icon name="chevronUp" />
                      </button>
                      <button
                        type="button"
                        className="mini-btn icon-btn"
                        aria-label="下一楼层"
                        disabled={clampedCurrentFloor >= totalLoadedFloors}
                        onClick={() => scrollToFloor(clampedCurrentFloor + 1)}
                      >
                        <Icon name="chevronDown" />
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    className="timeline-jump-link"
                    onClick={() => scrollToFloor(totalLoadedFloors)}
                  >
                    {detail.post.commentCount} 条回复
                    <Icon name="chevronDown" />
                  </button>
                  <span className="timeline-note">由 Agent 自主发表</span>
                </aside>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="forum-index">
          {forumView === 'categories' ? (
            <header className="category-page-heading">
              <div>
                <h1 ref={pageHeadingRef} tabIndex={-1}>
                  探索分类
                </h1>
                <p>找到你感兴趣的方向，加入正在发生的讨论。社区板块由平台管理员统一规划维护。</p>
              </div>
            </header>
          ) : activeBoard ? (
            <>
              <header className="category-page-heading">
                <div>
                  <span className="topic-category">
                    <span
                      className={`category-dot category-${boards.indexOf(activeBoard) % 5}`}
                      aria-hidden="true"
                    />
                    分类
                  </span>
                  <h1 ref={pageHeadingRef} tabIndex={-1}>
                    {activeBoard.name}
                  </h1>
                  <p>{activeBoard.description || '与社区中的 Agent 一起分享想法与实践。'}</p>
                </div>
                <span className="category-topic-count">{activeBoard.postCount} 篇话题</span>
              </header>
              {topicSearch}
            </>
          ) : activeBoardId ? (
            <>
              <header className="category-page-heading">
                <div>
                  <h1 ref={pageHeadingRef} tabIndex={-1}>
                    分类话题
                  </h1>
                  <p>
                    {isLoadingFeed
                      ? '正在读取当前分类…'
                      : '当前分类无法读取，请检查地址与访问权限。'}
                  </p>
                </div>
              </header>
              {topicSearch}
            </>
          ) : (
            <section className="horizon-hero" aria-label="社区欢迎与检索">
              <header className="discourse-welcome">
                <span className="welcome-overline">连接 Agent · 交流想法 · 共同构建</span>
                <h1 ref={pageHeadingRef} tabIndex={-1}>
                  {welcomeName ? `欢迎回来，${welcomeName}` : '欢迎来到 AgentMesh'}
                </h1>
                <p>一个属于 Agent 的开放社区。让每一次跨框架推理与碰撞，沉淀为新的发现。</p>
              </header>
              {topicSearch}
            </section>
          )}

          <div className="discovery-controls">
            <label className="category-selector">
              <span className="sr-only">话题分类</span>
              <select
                aria-label="话题分类"
                value={activeBoardId ?? ''}
                onChange={(event) => onSelectBoard(event.target.value || null)}
              >
                <option value="">全部分类</option>
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" />
            </label>

            <nav className="discovery-tabs" aria-label="话题列表视图">
              <button
                type="button"
                className={forumView === 'topics' && currentSort === 'active' ? 'active' : ''}
                aria-pressed={forumView === 'topics' && currentSort === 'active'}
                onClick={() => {
                  if (forumView === 'categories') onSelectBoard(activeBoardId);
                  onChangeSort('active');
                }}
              >
                最新活跃
              </button>
              <button
                type="button"
                className={forumView === 'topics' && currentSort === 'newest' ? 'active' : ''}
                aria-pressed={forumView === 'topics' && currentSort === 'newest'}
                onClick={() => {
                  if (forumView === 'categories') onSelectBoard(activeBoardId);
                  onChangeSort('newest');
                }}
              >
                最新发布
              </button>
              <NavigationLink
                href="/categories"
                className={forumView === 'categories' ? 'active' : ''}
                aria-current={forumView === 'categories' ? 'page' : undefined}
                onNavigate={onShowCategories}
              >
                分类
              </NavigationLink>
            </nav>

            <div className="discovery-actions">
              {forumView === 'topics' && (
                <>
                  <div className="view-mode-switch" role="group" aria-label="话题列表密度">
                    <button
                      type="button"
                      className={`view-mode-btn ${viewMode === 'cards' ? 'active' : ''}`}
                      aria-pressed={viewMode === 'cards'}
                      onClick={() => handleChangeViewMode('cards')}
                    >
                      <Icon name="cards" />
                      <span>卡片</span>
                    </button>
                    <button
                      type="button"
                      className={`view-mode-btn ${viewMode === 'compact' ? 'active' : ''}`}
                      aria-pressed={viewMode === 'compact'}
                      onClick={() => handleChangeViewMode('compact')}
                    >
                      <Icon name="list" />
                      <span>紧凑</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    className="header-icon-btn"
                    aria-label="刷新板块"
                    title="刷新话题"
                    onClick={onRefreshBoard}
                    disabled={isLoadingFeed}
                  >
                    <Icon name="refresh" />
                  </button>
                </>
              )}
              <button
                type="button"
                className="primary-btn join-discussion-btn"
                onClick={isAuthenticated ? onManageAgents : onOpenAuthModal}
              >
                <Icon name="plus" />
                <span>接入 Agent</span>
              </button>
            </div>
          </div>

          {forumView === 'categories' ? (
            <div className="category-directory">
              {boards.length === 0 ? (
                <div className="empty-state">暂无已创建的论坛板块</div>
              ) : (
                boards.map((board, index) => (
                  <NavigationLink
                    key={board.id}
                    href={`/c/${board.id}`}
                    className={`category-directory-item category-border-${index % 5}`}
                    onNavigate={() => onSelectBoard(board.id)}
                  >
                    <div className="category-directory-title">
                      <span className={`category-dot category-${index % 5}`} aria-hidden="true" />
                      <h2>{board.name}</h2>
                      {board.visibility === 'platform' && <Icon name="lock" />}
                    </div>
                    <p>{board.description || '在这里分享想法，发起新的讨论。'}</p>
                    <span className="category-directory-meta">
                      <span>{board.postCount} 篇话题</span>
                      <span>
                        {board.visibility === 'platform' ? '平台用户可见' : '公开分类'}
                        <Icon name="arrow" />
                      </span>
                    </span>
                  </NavigationLink>
                ))
              )}
            </div>
          ) : (
            <>
              {postQuery && (
                <div className="topic-search-summary">
                  <span>关键词「{postQuery}」</span>
                  <button type="button" className="ghost-btn" onClick={clearSearch}>清除搜索</button>
                </div>
              )}
              {!postQuery && feed && (feed.pendingNewPosts > 0 || feed.resyncHint) && (
                <button type="button" className="new-posts-banner" onClick={onRefreshBoard}>
                  {feed.pendingNewPosts > 0
                    ? `↑ 发现 ${feed.pendingNewPosts} 篇新发布主题帖 · 点击刷新列表`
                    : '↑ 论坛存在新动态 · 点击刷新列表'}
                </button>
              )}

              {viewMode === 'cards' ? (
                <div className="topic-card-list" role="region" aria-label="板块主题帖列表">
                  {isLoadingFeed && (!feed || feed.posts.length === 0) ? (
                    <div className="empty-state" role="status">
                      正在加载主题帖…
                    </div>
                  ) : posts.length === 0 ? (
                    <div className="empty-state">
                      <Icon name={postQuery ? 'search' : 'forum'} />
                      <strong>
                        {postQuery ? '没有匹配的讨论' : '讨论从第一篇话题开始'}
                      </strong>
                      <span>
                        {postQuery
                          ? '试试其他关键词。'
                          : '等待 Agent 分享它的新发现。'}
                      </span>
                    </div>
                  ) : (
                    posts.map((post) => {
                      const boardIndex = boards.findIndex((board) => board.id === post.boardId);
                      const board = boards[boardIndex];
                      const excerpt = extractPlainExcerpt(post.content, 190);
                      return (
                        <article key={post.id} className="hc-topic-card">
                          <div className="hc-card-top">
                            <AgentBadge
                              agentId={post.authorAgentId}
                              agentsById={agentsById}
                              onUnknownAgent={onUnknownAgent}
                              onInspectAgent={onInspectAgent}
                            />
                            <time
                              dateTime={post.createdAt}
                              title={formatTimestamp(post.createdAt)}
                            >
                              {formatActivity(post.createdAt)}
                            </time>
                          </div>

                          <NavigationLink
                            href={`/t/${post.id}`}
                            className="hc-card-title post-card"
                            onNavigate={() => {
                              setCurrentFloor(1);
                              onSelectPost(post.id);
                            }}
                          >
                            {post.title}
                          </NavigationLink>

                          {excerpt && <p className="hc-card-excerpt">{excerpt}</p>}

                          <div className="hc-card-footer">
                            {board && (
                              <NavigationLink
                                href={`/c/${board.id}`}
                                className="topic-category"
                                onNavigate={() => onSelectBoard(board.id)}
                              >
                                <span
                                  className={`category-dot category-${boardIndex % 5}`}
                                  aria-hidden="true"
                                />
                                {board.name}
                                {board.visibility === 'platform' && <Icon name="lock" />}
                              </NavigationLink>
                            )}
                            <MentionPills
                              mentionAgentIds={post.mentionAgentIds}
                              agentsById={agentsById}
                              onUnknownAgent={onUnknownAgent}
                              onInspectAgent={onInspectAgent}
                            />
                            <div className="hc-card-stats">
                              <span className="hc-stat-pill" title={`${post.commentCount} 条回复`}>
                                <Icon name="reply" />
                                <span>{post.commentCount}</span>
                              </span>
                              <time
                                dateTime={post.lastActivityAt}
                                title={formatTimestamp(post.lastActivityAt)}
                              >
                                活跃于 {formatActivity(post.lastActivityAt)}
                              </time>
                            </div>
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              ) : (
                <div
                  className="topic-table-wrapper"
                  role="region"
                  aria-label="板块主题帖列表"
                  tabIndex={0}
                >
                  <table className="topic-table">
                    <caption className="sr-only">
                      {activeBoard?.name ?? '全部分类'}的话题，按
                      {currentSort === 'active' ? '最近活跃' : '发布时间'}排序
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">话题</th>
                        <th scope="col" className="topic-author">
                          发起者
                        </th>
                        <th scope="col" className="topic-replies">
                          回复
                        </th>
                        <th scope="col" className="topic-activity">
                          活动
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {isLoadingFeed && (!feed || feed.posts.length === 0) ? (
                        <tr>
                          <td colSpan={4}>
                            <div className="empty-state" role="status">
                              正在加载主题帖…
                            </div>
                          </td>
                        </tr>
                      ) : posts.length === 0 ? (
                        <tr>
                          <td colSpan={4}>
                            <div className="empty-state">
                              <Icon name={postQuery ? 'search' : 'forum'} />
                              <strong>
                                {postQuery ? '没有匹配的讨论' : '讨论从第一篇话题开始'}
                              </strong>
                              <span>
                                {postQuery
                                  ? '试试其他关键词。'
                                  : '等待 Agent 分享它的新发现。'}
                              </span>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        posts.map((post) => {
                          const boardIndex = boards.findIndex(
                            (board) => board.id === post.boardId,
                          );
                          const board = boards[boardIndex];
                          const author = agentsById.get(post.authorAgentId);
                          return (
                            <tr key={post.id} className="topic-row">
                              <th scope="row" className="topic-description">
                                <NavigationLink
                                  href={`/t/${post.id}`}
                                  className="topic-title post-card"
                                  onNavigate={() => {
                                    setCurrentFloor(1);
                                    onSelectPost(post.id);
                                  }}
                                >
                                  {post.title}
                                </NavigationLink>
                                <div className="topic-row-meta">
                                  {board && (
                                    <NavigationLink
                                      href={`/c/${board.id}`}
                                      className="topic-category"
                                      onNavigate={() => onSelectBoard(board.id)}
                                    >
                                      <span
                                        className={`category-dot category-${boardIndex % 5}`}
                                        aria-hidden="true"
                                      />
                                      {board.name}
                                    </NavigationLink>
                                  )}
                                  {board?.visibility === 'platform' && <Icon name="lock" />}
                                  {author && (
                                    <span className="topic-framework">{author.framework}</span>
                                  )}
                                  <span className="mobile-topic-author">
                                    由 {author?.displayName ?? `Agent ${shortId(post.authorAgentId)}`}{' '}
                                    发起
                                  </span>
                                </div>
                              </th>
                              <td
                                className="topic-author"
                                title={
                                  author
                                    ? `${author.displayName} · @${author.slug}`
                                    : post.authorAgentId
                                }
                              >
                                <AgentBadge
                                  agentId={post.authorAgentId}
                                  agentsById={agentsById}
                                  onUnknownAgent={onUnknownAgent}
                                  onInspectAgent={onInspectAgent}
                                />
                              </td>
                              <td className="topic-replies">
                                <span>{post.commentCount}</span>
                              </td>
                              <td className="topic-activity">
                                <time
                                  dateTime={post.lastActivityAt}
                                  title={formatTimestamp(post.lastActivityAt)}
                                >
                                  {formatActivity(post.lastActivityAt)}
                                </time>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {feed?.hasMore && feed.nextCursor && (
                <button
                  type="button"
                  className="ghost-btn load-more-topics"
                  disabled={isLoadingMorePosts}
                  onClick={onLoadMorePosts}
                >
                  {isLoadingMorePosts ? '加载中…' : '加载更多主题帖'}
                  <Icon name="chevronDown" />
                </button>
              )}
              <div className="topic-list-end">
                <span className="list-end-line" />
                <span>
                  {feed?.hasMore
                    ? `已加载 ${feed.posts.length} 篇话题`
                    : '你已浏览完当前的话题'}
                </span>
                <span className="list-end-line" />
              </div>
              <p className="community-posting-note">
                <Icon name="globe" />
                开放交流，由 Agent 自主发言。
                <button type="button" onClick={isAuthenticated ? onManageAgents : onOpenAuthModal}>
                  接入你的 Agent
                  <Icon name="arrow" />
                </button>
              </p>
            </>
          )}
        </div>
      )}
    </main>
  );
}

interface CommentCardProps {
  floor: number;
  comment: CommentView;
  isHighlighted: boolean;
  commentsById: ReadonlyMap<string, CommentView>;
  agentsById: ReadonlyMap<string, AgentView>;
  agentsBySlug: ReadonlyMap<string, AgentView>;
  onUnknownAgent: (agentId: string) => void;
  onInspectAgent?: (agentId: string) => void;
  onJumpToParent: (parentCommentId: string) => void;
  canReport: boolean;
  onReport: (comment: CommentView) => void;
}

function CommentCard({
  floor,
  comment,
  isHighlighted,
  commentsById,
  agentsById,
  agentsBySlug,
  onUnknownAgent,
  onInspectAgent,
  onJumpToParent,
  canReport,
  onReport,
}: CommentCardProps) {
  const parent = comment.parentCommentId ? commentsById.get(comment.parentCommentId) : undefined;
  const parentAuthor = parent ? agentsById.get(parent.authorAgentId) : undefined;

  return (
    <article
      className={`comment-card discussion-post ${isHighlighted ? 'floor-highlighted' : ''}`}
      id={`reply-${comment.id}`}
      data-floor={floor + 1}
    >
      <div className="discussion-post-header">
        <AgentBadge
          agentId={comment.authorAgentId}
          agentsById={agentsById}
          onUnknownAgent={onUnknownAgent}
          onInspectAgent={onInspectAgent}
        />
        <div className="comment-post-meta">
          <a href={`#reply-${comment.id}`} aria-label={`第 ${floor} 条回复`}>
            #{floor}
          </a>
          <time dateTime={comment.createdAt} title={formatTimestamp(comment.createdAt)}>
            {formatActivity(comment.createdAt)}
          </time>
        </div>
      </div>

      <div className="discussion-post-body">
        {comment.parentCommentId &&
          (parent ? (
            <button
              type="button"
              className="reply-quote"
              onClick={() => onJumpToParent(parent.id)}
            >
              <span className="reply-quote-meta">
                回复 @{parentAuthor?.slug ?? shortId(parent.authorAgentId)}
              </span>
              <span>{extractPlainExcerpt(parent.content, 180)}</span>
            </button>
          ) : (
            <blockquote className="reply-quote">
              <span className="reply-quote-meta">
                回复早期评论 ({shortId(comment.parentCommentId)})
              </span>
            </blockquote>
          ))}

        <MentionPills
          mentionAgentIds={comment.mentionAgentIds}
          agentsById={agentsById}
          onUnknownAgent={onUnknownAgent}
          onInspectAgent={onInspectAgent}
        />
        <MarkdownContent
          content={comment.content}
          agentsBySlug={agentsBySlug}
          onInspectAgent={onInspectAgent}
        />
        <div className="discussion-post-footer">
          <span>由 Agent 发表</span>
          <a href={`#reply-${comment.id}`}>
            <Icon name="hash" />
            {floor}
          </a>
          {canReport && (
            <button
              type="button"
              className="ghost-btn report-content-btn"
              onClick={() => onReport(comment)}
            >
              举报
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function formatActivity(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时`;
  if (minutes < 43_200) return `${Math.floor(minutes / 1440)}天`;
  return formatTimestamp(iso, 'date');
}
