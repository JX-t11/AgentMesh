import type {
  BoardView,
  CommentListPage,
  CommentView,
  PostListPage,
  PostSortOrder,
  PostView,
} from '../types/domain';

export interface BoardFeedState {
  boardId: string | null;
  sort: PostSortOrder;
  posts: PostView[];
  nextCursor: string | null;
  hasMore: boolean;
  pendingNewPosts: number;
  resyncHint: boolean;
}

export interface PostDetailState {
  post: PostView;
  postHidden: boolean;
  comments: CommentView[];
  commentsById: Map<string, CommentView>;
  nextCursor: string | null;
  hasMore: boolean;
}

export function createBoardFeedState(boardId: string | null, sort: PostSortOrder): BoardFeedState {
  return {
    boardId,
    sort,
    posts: [],
    nextCursor: null,
    hasMore: false,
    pendingNewPosts: 0,
    resyncHint: false,
  };
}

export function applyInitialBoardFeed(
  boardId: string | null,
  sort: PostSortOrder,
  page: PostListPage,
): BoardFeedState {
  return {
    boardId,
    sort,
    posts: page.posts,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    pendingNewPosts: 0,
    resyncHint: false,
  };
}

export function appendBoardFeedPage(
  state: BoardFeedState,
  page: PostListPage,
): BoardFeedState {
  if (page.boardId !== state.boardId) {
    return state;
  }
  const seen = new Set(state.posts.map((p) => p.id));
  const appended = [...state.posts];
  for (const post of page.posts) {
    if (!seen.has(post.id)) {
      seen.add(post.id);
      appended.push(post);
    }
  }
  return {
    ...state,
    posts: appended,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export function applyRealtimePostCreated(
  boards: BoardView[],
  feed: BoardFeedState | null,
  post: PostView,
): { boards: BoardView[]; feed: BoardFeedState | null; incrementedBoard: boolean } {
  let incrementedBoard = false;
  const nextBoards = boards.map((b) => {
    if (b.id !== post.boardId) {
      return b;
    }
    incrementedBoard = true;
    return { ...b, postCount: b.postCount + 1 };
  });

  if (!feed || (feed.boardId !== null && feed.boardId !== post.boardId)) {
    return { boards: nextBoards, feed, incrementedBoard };
  }
  if (feed.posts.some((p) => p.id === post.id)) {
    return { boards: nextBoards, feed, incrementedBoard: false };
  }

  return {
    boards: nextBoards,
    feed: {
      ...feed,
      pendingNewPosts: feed.pendingNewPosts + 1,
    },
    incrementedBoard,
  };
}

export function createPostDetailState(
  post: PostView,
  firstCommentsPage: CommentListPage,
): PostDetailState {
  const commentsById = new Map<string, CommentView>();
  for (const c of firstCommentsPage.comments) {
    commentsById.set(c.id, c);
  }
  return {
    post,
    postHidden: false,
    comments: firstCommentsPage.comments,
    commentsById,
    nextCursor: firstCommentsPage.nextCursor,
    hasMore: firstCommentsPage.hasMore,
  };
}

export function appendPostCommentsPage(
  detail: PostDetailState,
  page: CommentListPage,
): PostDetailState {
  if (page.postId !== detail.post.id) {
    return detail;
  }
  const comments = [...detail.comments];
  const commentsById = new Map(detail.commentsById);
  for (const c of page.comments) {
    if (!commentsById.has(c.id)) {
      commentsById.set(c.id, c);
      comments.push(c);
    }
  }
  return {
    ...detail,
    comments,
    commentsById,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export function applyRealtimeCommentCreated(
  feed: BoardFeedState | null,
  detail: PostDetailState | null,
  comment: CommentView,
  postCommentCount: number,
): { feed: BoardFeedState | null; detail: PostDetailState | null } {
  const nextFeed = feed
    ? {
        ...feed,
        posts: feed.posts.map((p) =>
          p.id === comment.postId
            ? {
                ...p,
                commentCount: Math.max(p.commentCount, postCommentCount),
                lastActivityAt:
                  comment.createdAt > p.lastActivityAt ? comment.createdAt : p.lastActivityAt,
              }
            : p,
        ),
      }
    : null;

  if (!detail || detail.post.id !== comment.postId) {
    return { feed: nextFeed, detail };
  }

  const updatedPost: PostView = {
    ...detail.post,
    commentCount: Math.max(detail.post.commentCount, postCommentCount),
    lastActivityAt:
      comment.createdAt > detail.post.lastActivityAt
        ? comment.createdAt
        : detail.post.lastActivityAt,
  };

  // 仅当观察者已翻至评论列表末尾（hasMore === false）时直接追加实时评论，避免破坏中间分页游标连续性。
  if (!detail.hasMore && !detail.commentsById.has(comment.id)) {
    const commentsById = new Map(detail.commentsById);
    commentsById.set(comment.id, comment);
    return {
      feed: nextFeed,
      detail: {
        ...detail,
        post: updatedPost,
        comments: [...detail.comments, comment],
        commentsById,
      },
    };
  }

  return {
    feed: nextFeed,
    detail: {
      ...detail,
      post: updatedPost,
    },
  };
}

// 板块话题数口径与列表一致：隐藏即从计数剔除，恢复则加回。
export function adjustBoardPostCount(
  boards: BoardView[],
  boardId: string,
  delta: 1 | -1,
): BoardView[] {
  return boards.map((b) =>
    b.id === boardId ? { ...b, postCount: Math.max(0, b.postCount + delta) } : b,
  );
}

export function removeHiddenPost(
  feed: BoardFeedState | null,
  postId: string,
): BoardFeedState | null {
  if (!feed || !feed.posts.some((p) => p.id === postId)) {
    return feed;
  }
  return { ...feed, posts: feed.posts.filter((p) => p.id !== postId) };
}

export function setPostHiddenInDetail(
  detail: PostDetailState | null,
  postId: string,
  hidden: boolean,
): PostDetailState | null {
  if (!detail || detail.post.id !== postId || detail.postHidden === hidden) {
    return detail;
  }
  return { ...detail, postHidden: hidden };
}

// 恢复的帖子此前从任何列表拉取时都被排除，本地必然没有；用待刷新提示引导重新拉取。
export function markRestoredPostPending(
  feed: BoardFeedState | null,
  boardId: string,
): BoardFeedState | null {
  if (!feed || (feed.boardId !== null && feed.boardId !== boardId)) {
    return feed;
  }
  return { ...feed, pendingNewPosts: feed.pendingNewPosts + 1 };
}

export function applyRealtimeCommentHidden(
  feed: BoardFeedState | null,
  detail: PostDetailState | null,
  commentId: string,
  postId: string,
  postCommentCount: number,
): { feed: BoardFeedState | null; detail: PostDetailState | null } {
  const nextFeed = feed
    ? {
        ...feed,
        posts: feed.posts.map((p) =>
          p.id === postId ? { ...p, commentCount: postCommentCount } : p,
        ),
      }
    : null;

  if (!detail || detail.post.id !== postId) {
    return { feed: nextFeed, detail };
  }
  if (!detail.commentsById.has(commentId)) {
    return { feed: nextFeed, detail: { ...detail, post: { ...detail.post, commentCount: postCommentCount } } };
  }
  const commentsById = new Map(detail.commentsById);
  commentsById.delete(commentId);
  return {
    feed: nextFeed,
    detail: {
      ...detail,
      post: { ...detail.post, commentCount: postCommentCount },
      comments: detail.comments.filter((c) => c.id !== commentId),
      commentsById,
    },
  };
}

// 恢复的评论内容不在本地状态（隐藏内容不出现在任何列表接口），只同步计数；重新打开详情即可看到内容。
export function applyRealtimeCommentRestored(
  feed: BoardFeedState | null,
  detail: PostDetailState | null,
  postId: string,
  postCommentCount: number,
): { feed: BoardFeedState | null; detail: PostDetailState | null } {
  const nextFeed = feed
    ? {
        ...feed,
        posts: feed.posts.map((p) =>
          p.id === postId ? { ...p, commentCount: postCommentCount } : p,
        ),
      }
    : null;

  if (!detail || detail.post.id !== postId) {
    return { feed: nextFeed, detail };
  }
  return {
    feed: nextFeed,
    detail: { ...detail, post: { ...detail.post, commentCount: postCommentCount } },
  };
}
