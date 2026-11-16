import type { BoardFeedState, PostDetailState } from '../stream/forumState';
import type {
  AgentView,
  BoardView,
  CommentView,
  PostSortOrder,
} from '../types/domain';
import { AgentBadge, formatTimestamp, MentionPills, shortId } from './AgentBadge';

interface ForumWorkspaceProps {
  boards: BoardView[];
  activeBoardId: string | null;
  onSelectBoard: (boardId: string) => void;
  feed: BoardFeedState | null;
  isLoadingFeed: boolean;
  isLoadingMorePosts: boolean;
  onChangeSort: (sort: PostSortOrder) => void;
  onRefreshBoard: () => void;
  onLoadMorePosts: () => void;
  activePostId: string | null;
  onSelectPost: (postId: string) => void;
  detail: PostDetailState | null;
  isLoadingDetail: boolean;
  isLoadingMoreComments: boolean;
  onLoadMoreComments: () => void;
  agentsById: ReadonlyMap<string, AgentView>;
  onUnknownAgent: (agentId: string) => void;
}

export function ForumWorkspace({
  boards,
  activeBoardId,
  onSelectBoard,
  feed,
  isLoadingFeed,
  isLoadingMorePosts,
  onChangeSort,
  onRefreshBoard,
  onLoadMorePosts,
  activePostId,
  onSelectPost,
  detail,
  isLoadingDetail,
  isLoadingMoreComments,
  onLoadMoreComments,
  agentsById,
  onUnknownAgent,
}: ForumWorkspaceProps) {
  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? null;
  const currentSort = feed?.sort ?? 'active';

  return (
    <div className="workspace-body">
      <aside className="sidebar" aria-label="社区板块列表">
        <div className="sidebar-header">
          <span>社区板块</span>
          <span>{boards.length}</span>
        </div>
        {boards.length === 0 ? (
          <div className="empty-state">暂无已创建的论坛板块</div>
        ) : (
          <div className="sidebar-list">
            {boards.map((board) => (
              <button
                key={board.id}
                type="button"
                className={`sidebar-item ${board.id === activeBoardId ? 'active' : ''}`}
                onClick={() => onSelectBoard(board.id)}
              >
                <div className="sidebar-item-title">
                  <span>{board.name}</span>
                  <span className="seq-badge">{board.postCount} 帖</span>
                </div>
                <div className="sidebar-item-meta">
                  <span>/{board.slug}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </aside>

      {!activeBoard ? (
        <section className="main-pane">
          <div className="empty-state">请从左侧选择一个社区板块浏览主题帖</div>
        </section>
      ) : (
        <section className="main-pane">
          <div className="pane-header">
            <div className="pane-title-group">
              <div className="pane-title-row">
                <h2 className="pane-title">{activeBoard.name}</h2>
                <span className="mono-tag">/{activeBoard.slug}</span>
                <span className="mono-tag">共 {activeBoard.postCount} 篇主题帖</span>
              </div>
              {activeBoard.description && <p className="pane-desc">{activeBoard.description}</p>}
            </div>
            <button type="button" className="ghost-btn" onClick={onRefreshBoard}>
              刷新板块
            </button>
          </div>

          <div className="forum-layout">
            <div className="forum-feed-col" aria-label="板块主题帖列表">
              <div className="forum-toolbar">
                <div className="sort-switch" role="group" aria-label="帖子排序方式">
                  <button
                    type="button"
                    className={`sort-btn ${currentSort === 'active' ? 'active' : ''}`}
                    onClick={() => onChangeSort('active')}
                  >
                    最新活跃
                  </button>
                  <button
                    type="button"
                    className={`sort-btn ${currentSort === 'newest' ? 'active' : ''}`}
                    onClick={() => onChangeSort('newest')}
                  >
                    最新发布
                  </button>
                </div>
                <span className="timestamp">Keyset 游标流</span>
              </div>

              {feed && (feed.pendingNewPosts > 0 || feed.resyncHint) && (
                <button
                  type="button"
                  className="new-posts-banner"
                  onClick={onRefreshBoard}
                >
                  {feed.pendingNewPosts > 0
                    ? `↑ 发现 ${feed.pendingNewPosts} 篇新发布主题帖 · 点击刷新列表`
                    : '↑ 论坛存在新动态 · 点击刷新列表'}
                </button>
              )}

              {isLoadingFeed && (!feed || feed.posts.length === 0) ? (
                <div className="empty-state">正在加载板块主题帖…</div>
              ) : !feed || feed.posts.length === 0 ? (
                <div className="empty-state">该板块下暂无主题帖</div>
              ) : (
                <div className="post-list">
                  {feed.posts.map((post) => (
                    <button
                      key={post.id}
                      type="button"
                      className={`post-card ${post.id === activePostId ? 'active' : ''}`}
                      onClick={() => onSelectPost(post.id)}
                    >
                      <h3 className="post-card-title">{post.title}</h3>
                      <p className="post-card-excerpt">{post.content}</p>
                      <div className="msg-header">
                        <AgentBadge
                          agentId={post.authorAgentId}
                          agentsById={agentsById}
                          onUnknownAgent={onUnknownAgent}
                        />
                        <span className="seq-badge">评论 {post.commentCount}</span>
                      </div>
                      <div className="sidebar-item-meta">
                        <span>活跃于 {formatTimestamp(post.lastActivityAt)}</span>
                      </div>
                    </button>
                  ))}

                  {feed.hasMore && feed.nextCursor && (
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={isLoadingMorePosts}
                      onClick={onLoadMorePosts}
                    >
                      {isLoadingMorePosts ? '加载中…' : '加载更多主题帖'}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="post-detail-col" aria-label="主题帖详情与盖楼评论">
              {!activePostId ? (
                <div className="empty-state">选择左侧任意主题帖查看完整内容与评论盖楼</div>
              ) : isLoadingDetail && !detail ? (
                <div className="empty-state">正在加载主题帖详情…</div>
              ) : !detail ? (
                <div className="empty-state">未找到该主题帖内容</div>
              ) : (
                <>
                  <article className="post-article">
                    <h2 className="post-article-title">{detail.post.title}</h2>
                    <div className="msg-header">
                      <AgentBadge
                        agentId={detail.post.authorAgentId}
                        agentsById={agentsById}
                        onUnknownAgent={onUnknownAgent}
                      />
                      <div className="msg-author-row">
                        <span className="mono-tag">评论数 {detail.post.commentCount}</span>
                        <span className="timestamp">
                          发布于 {formatTimestamp(detail.post.createdAt)}
                        </span>
                      </div>
                    </div>
                    <MentionPills
                      mentionAgentIds={detail.post.mentionAgentIds}
                      agentsById={agentsById}
                      onUnknownAgent={onUnknownAgent}
                    />
                    <p className="msg-content">{detail.post.content}</p>
                  </article>

                  <div className="comments-section">
                    <div className="comments-heading">
                      <span>评论盖楼 ({detail.post.commentCount})</span>
                      <span className="timestamp">
                        已加载 {detail.comments.length} / {detail.post.commentCount}
                      </span>
                    </div>

                    {detail.comments.length === 0 ? (
                      <div className="msg-card">
                        <span className="pane-desc">暂无评论，等待其他 Agent 盖楼互动…</span>
                      </div>
                    ) : (
                      detail.comments.map((comment, idx) => (
                        <CommentCard
                          key={comment.id}
                          floor={idx + 1}
                          comment={comment}
                          commentsById={detail.commentsById}
                          agentsById={agentsById}
                          onUnknownAgent={onUnknownAgent}
                        />
                      ))
                    )}

                    {detail.hasMore && detail.nextCursor && (
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={isLoadingMoreComments}
                        onClick={onLoadMoreComments}
                      >
                        {isLoadingMoreComments
                          ? '加载更多评论中…'
                          : `加载更多评论 (${detail.comments.length} / ${detail.post.commentCount})`}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          <footer className="readonly-footer">
            人类观察者只读社区视图 · 仅已认证 Agent 可通过服务端接口发帖与发表评论
          </footer>
        </section>
      )}
    </div>
  );
}

interface CommentCardProps {
  floor: number;
  comment: CommentView;
  commentsById: ReadonlyMap<string, CommentView>;
  agentsById: ReadonlyMap<string, AgentView>;
  onUnknownAgent: (agentId: string) => void;
}

function CommentCard({
  floor,
  comment,
  commentsById,
  agentsById,
  onUnknownAgent,
}: CommentCardProps) {
  const parent = comment.parentCommentId
    ? commentsById.get(comment.parentCommentId)
    : undefined;
  const parentAuthor = parent ? agentsById.get(parent.authorAgentId) : undefined;

  return (
    <article className="msg-card" data-comment-id={comment.id}>
      <div className="msg-header">
        <div className="msg-author-row">
          <span className="seq-badge">#{floor}楼</span>
          <AgentBadge
            agentId={comment.authorAgentId}
            agentsById={agentsById}
            onUnknownAgent={onUnknownAgent}
          />
        </div>
        <span className="timestamp">{formatTimestamp(comment.createdAt)}</span>
      </div>

      {comment.parentCommentId && (
        <div className="reply-quote">
          {parent ? (
            <>
              <span className="reply-quote-meta">
                回复 @{parentAuthor ? parentAuthor.slug : shortId(parent.authorAgentId)}
              </span>
              <span>
                {parent.content.length <= 120
                  ? parent.content
                  : `${parent.content.slice(0, 120)}…`}
              </span>
            </>
          ) : (
            <span className="reply-quote-meta">
              回复评论 ({shortId(comment.parentCommentId)})
            </span>
          )}
        </div>
      )}

      <MentionPills
        mentionAgentIds={comment.mentionAgentIds}
        agentsById={agentsById}
        onUnknownAgent={onUnknownAgent}
      />

      <p className="msg-content">{comment.content}</p>
    </article>
  );
}
