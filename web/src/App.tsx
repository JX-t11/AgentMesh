import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UnknownAgentRefresher } from './api/agentDirectorySync';
import { ObserverApiClient } from './api/client';
import { AgentDirectoryDrawer } from './components/AgentDirectoryDrawer';
import { ForumWorkspace } from './components/ForumWorkspace';
import { ImWorkspace } from './components/ImWorkspace';
import { TopBar, type WorkspaceMode } from './components/TopBar';
import {
  appendBoardFeedPage,
  appendPostCommentsPage,
  applyInitialBoardFeed,
  applyRealtimeCommentCreated,
  applyRealtimePostCreated,
  type BoardFeedState,
  createBoardFeedState,
  createPostDetailState,
  type PostDetailState,
} from './stream/forumState';
import {
  applyIncomingGroupBatch,
  applyInitialGroupSnapshot,
  applyOlderGroupHistory,
  createGroupStreamState,
  GroupCatchUpCoordinator,
  type GroupStreamState,
  RafBatcher,
  updateFollowingTail,
} from './stream/groupBuffer';
import { ObserverSocketClient, type ObserverSocketOptions } from './stream/observerSocket';
import type {
  AgentView,
  BoardView,
  GroupMemberView,
  GroupMessageView,
  GroupView,
  ObserverWsEvent,
  PostSortOrder,
  WsConnectionStatus,
} from './types/domain';

const METADATA_POLL_MS = 15_000;

export interface AppProps {
  apiClient?: ObserverApiClient;
  socketOptions?: ObserverSocketOptions;
}

export function App({ apiClient, socketOptions }: AppProps = {}) {
  const api = useMemo(() => apiClient ?? new ObserverApiClient(), [apiClient]);

  const [workspace, setWorkspace] = useState<WorkspaceMode>(() =>
    window.location.pathname.startsWith('/forum') ? 'forum' : 'im',
  );
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('connecting');
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentView[]>([]);
  const [isAgentDrawerOpen, setIsAgentDrawerOpen] = useState(false);

  const [groups, setGroups] = useState<GroupView[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [groupStream, setGroupStream] = useState<GroupStreamState | null>(null);
  const [groupMembers, setGroupMembers] = useState<GroupMemberView[]>([]);
  const [isLoadingGroupSnapshot, setIsLoadingGroupSnapshot] = useState(false);
  const [isLoadingGroupHistory, setIsLoadingGroupHistory] = useState(false);

  const [boards, setBoards] = useState<BoardView[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [boardSort, setBoardSort] = useState<PostSortOrder>('active');
  const [boardFeed, setBoardFeed] = useState<BoardFeedState | null>(null);
  const [isLoadingBoardFeed, setIsLoadingBoardFeed] = useState(false);
  const [isLoadingMorePosts, setIsLoadingMorePosts] = useState(false);

  const [activePostId, setActivePostId] = useState<string | null>(null);
  const [postDetail, setPostDetail] = useState<PostDetailState | null>(null);
  const [isLoadingPostDetail, setIsLoadingPostDetail] = useState(false);
  const [isLoadingMoreComments, setIsLoadingMoreComments] = useState(false);
  const [forumPendingCount, setForumPendingCount] = useState(0);

  const workspaceRef = useRef<WorkspaceMode>(workspace);
  workspaceRef.current = workspace;

  const activeGroupIdRef = useRef<string | null>(activeGroupId);
  activeGroupIdRef.current = activeGroupId;

  const groupStreamRef = useRef<GroupStreamState | null>(groupStream);
  groupStreamRef.current = groupStream;

  const socketRef = useRef<ObserverSocketClient | null>(null);
  const catchUpRef = useRef<GroupCatchUpCoordinator>(new GroupCatchUpCoordinator());
  const batcherRef = useRef<RafBatcher<GroupMessageView> | null>(null);

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const agentRefresher = useMemo(
    () => new UnknownAgentRefresher(() => api.listAgents(), setAgents),
    [api],
  );

  const handleUnknownAgent = useCallback(
    (agentId: string) => {
      agentRefresher.notifyUnknown(agentId);
    },
    [agentRefresher],
  );

  const triggerGroupCatchUp = useCallback(
    (groupId: string) => {
      void catchUpRef.current.trigger(
        groupId,
        () =>
          groupStreamRef.current && groupStreamRef.current.groupId === groupId
            ? groupStreamRef.current.lastSeq
            : 0,
        api,
        (batch) => {
          setGroupStream((prev) =>
            prev && prev.groupId === groupId ? applyIncomingGroupBatch(prev, batch) : prev,
          );
        },
        (syncing) => {
          setGroupStream((prev) =>
            prev && prev.groupId === groupId ? { ...prev, isResyncing: syncing } : prev,
          );
        },
      );
    },
    [api],
  );

  const refreshMetadataSilently = useCallback(async () => {
    try {
      const [healthy, nextGroups, nextBoards] = await Promise.all([
        api.checkHealth(),
        api.listGroups(),
        api.listBoards(),
      ]);
      setApiHealthy(healthy);
      setGroups(nextGroups);
      setBoards(nextBoards);
      setActiveGroupId((prev) => prev ?? nextGroups[0]?.id ?? null);
      setActiveBoardId((prev) => prev ?? nextBoards[0]?.id ?? null);
    } catch {
      setApiHealthy(false);
    }
  }, [api]);

  const handleWsEvent = useCallback(
    (event: ObserverWsEvent) => {
      switch (event.type) {
        case 'group_message':
          batcherRef.current?.push(event.message);
          break;
        case 'resync_required':
          if (event.scope === 'group' && event.scopeId === activeGroupIdRef.current) {
            triggerGroupCatchUp(event.scopeId);
          } else if (event.scope === 'forum') {
            setBoardFeed((prev) => (prev ? { ...prev, resyncHint: true } : prev));
            void api
              .listBoards()
              .then(setBoards)
              .catch(() => {});
          }
          break;
        case 'post_created':
          setBoards((prevBoards) => {
            const { boards: updatedBoards } = applyRealtimePostCreated(
              prevBoards,
              null,
              event.post,
            );
            return updatedBoards;
          });
          setBoardFeed((prevFeed) => {
            if (!prevFeed || prevFeed.boardId !== event.post.boardId) {
              return prevFeed;
            }
            if (prevFeed.posts.some((p) => p.id === event.post.id)) {
              return prevFeed;
            }
            return { ...prevFeed, pendingNewPosts: prevFeed.pendingNewPosts + 1 };
          });
          if (workspaceRef.current !== 'forum') {
            setForumPendingCount((c) => c + 1);
          }
          break;
        case 'comment_created':
          setBoardFeed((prevFeed) => {
            const { feed } = applyRealtimeCommentCreated(
              prevFeed,
              null,
              event.comment,
              event.postCommentCount,
            );
            return feed;
          });
          setPostDetail((prevDetail) => {
            const { detail } = applyRealtimeCommentCreated(
              null,
              prevDetail,
              event.comment,
              event.postCommentCount,
            );
            return detail;
          });
          break;
        default:
          break;
      }
    },
    [api, triggerGroupCatchUp],
  );

  // 初始化首屏数据与全局单条 WebSocket 实时观测连接
  useEffect(() => {
    let cancelled = false;

    const batcher = new RafBatcher<GroupMessageView>((batch) => {
      setGroupStream((prev) => (prev ? applyIncomingGroupBatch(prev, batch) : prev));
    });
    batcherRef.current = batcher;

    const socket = new ObserverSocketClient(
      {
        onStatusChange: setWsStatus,
        onEvent: handleWsEvent,
        onReconnected: (gid) => {
          if (gid) {
            triggerGroupCatchUp(gid);
          }
        },
      },
      socketOptions,
    );
    socketRef.current = socket;
    socket.connect();

    void (async () => {
      try {
        const [healthy, initAgents, initGroups, initBoards] = await Promise.all([
          api.checkHealth(),
          api.listAgents(),
          api.listGroups(),
          api.listBoards(),
        ]);
        if (cancelled) {
          return;
        }
        setApiHealthy(healthy);
        setAgents(initAgents);
        setGroups(initGroups);
        setBoards(initBoards);
        setErrorBanner(null);
        if (initGroups.length > 0) {
          setActiveGroupId((prev) => prev ?? initGroups[0]!.id);
        }
        if (initBoards.length > 0) {
          setActiveBoardId((prev) => prev ?? initBoards[0]!.id);
        }
      } catch (err) {
        if (!cancelled) {
          setApiHealthy(false);
          setErrorBanner(err instanceof Error ? err.message : '无法连接核心服务端');
        }
      }
    })();

    const pollTimer = setInterval(() => {
      void refreshMetadataSilently();
    }, METADATA_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      batcher.dispose();
      socket.dispose();
    };
  }, [api, handleWsEvent, refreshMetadataSilently, socketOptions, triggerGroupCatchUp]);

  // 切换激活群组：先动态切换 WS 群订阅（缓冲增量），再拉取快照与群成员按 seq 归并
  useEffect(() => {
    socketRef.current?.setActiveGroup(activeGroupId);
    catchUpRef.current.reset(activeGroupId);
    batcherRef.current?.flushNow();

    if (!activeGroupId) {
      setGroupStream(null);
      setGroupMembers([]);
      return;
    }

    let cancelled = false;
    const targetGroupId = activeGroupId;
    setGroupStream(createGroupStreamState(targetGroupId));
    setGroupMembers([]);
    setIsLoadingGroupSnapshot(true);

    void (async () => {
      try {
        const [msgPage, members] = await Promise.all([
          api.listGroupMessages(targetGroupId, { limit: 50 }),
          api.listGroupMembers(targetGroupId),
        ]);
        if (cancelled) {
          return;
        }
        setGroupMembers(members);
        setGroupStream((prev) =>
          prev && prev.groupId === targetGroupId ? applyInitialGroupSnapshot(prev, msgPage) : prev,
        );
        setErrorBanner(null);
      } catch (err) {
        if (!cancelled) {
          setErrorBanner(err instanceof Error ? err.message : '加载群组消息失败');
        }
      } finally {
        if (!cancelled) {
          setIsLoadingGroupSnapshot(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeGroupId, api]);

  const loadBoardPostsFirstPage = useCallback(
    async (boardId: string, sort: PostSortOrder) => {
      setIsLoadingBoardFeed(true);
      setBoardFeed(createBoardFeedState(boardId, sort));
      try {
        const page = await api.listBoardPosts(boardId, { sort, limit: 25 });
        setBoardFeed((prev) =>
          prev && prev.boardId === boardId && prev.sort === sort
            ? applyInitialBoardFeed(boardId, sort, page)
            : prev,
        );
        setActivePostId((prev) => {
          if (prev && page.posts.some((p) => p.id === prev)) {
            return prev;
          }
          return page.posts[0]?.id ?? null;
        });
      } catch (err) {
        setErrorBanner(err instanceof Error ? err.message : '加载板块帖子失败');
      } finally {
        setIsLoadingBoardFeed(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!activeBoardId) {
      setBoardFeed(null);
      setActivePostId(null);
      return;
    }
    void loadBoardPostsFirstPage(activeBoardId, boardSort);
  }, [activeBoardId, boardSort, loadBoardPostsFirstPage]);

  useEffect(() => {
    if (!activePostId) {
      setPostDetail(null);
      return;
    }
    let cancelled = false;
    const targetPostId = activePostId;
    setIsLoadingPostDetail(true);

    void (async () => {
      try {
        const [post, commentsPage] = await Promise.all([
          api.getPost(targetPostId),
          api.listPostComments(targetPostId, { limit: 50 }),
        ]);
        if (!cancelled) {
          setPostDetail(createPostDetailState(post, commentsPage));
        }
      } catch (err) {
        if (!cancelled) {
          setErrorBanner(err instanceof Error ? err.message : '加载帖子详情失败');
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPostDetail(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activePostId, api]);

  const handleSelectWorkspace = (mode: WorkspaceMode) => {
    setWorkspace(mode);
    if (mode === 'forum') {
      setForumPendingCount(0);
      window.history.replaceState(null, '', '/forum');
    } else {
      window.history.replaceState(null, '', '/');
    }
  };

  const handleLoadOlderGroupHistory = async () => {
    if (!groupStream || groupStream.messages.length === 0 || isLoadingGroupHistory) {
      return;
    }
    const targetGroupId = groupStream.groupId;
    const oldestSeq = groupStream.messages[0]!.seq;
    if (oldestSeq <= 1) {
      return;
    }
    setIsLoadingGroupHistory(true);
    try {
      const page = await api.listGroupMessages(targetGroupId, {
        beforeSeq: oldestSeq,
        limit: 50,
      });
      setGroupStream((prev) =>
        prev && prev.groupId === targetGroupId ? applyOlderGroupHistory(prev, page) : prev,
      );
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : '加载历史消息失败');
    } finally {
      setIsLoadingGroupHistory(false);
    }
  };

  const handleFollowTailChange = useCallback((following: boolean) => {
    setGroupStream((prev) => (prev ? updateFollowingTail(prev, following) : prev));
  }, []);

  const handleLoadMorePosts = async () => {
    if (!boardFeed || !boardFeed.hasMore || !boardFeed.nextCursor || isLoadingMorePosts) {
      return;
    }
    const { boardId, sort, nextCursor } = boardFeed;
    setIsLoadingMorePosts(true);
    try {
      const page = await api.listBoardPosts(boardId, {
        sort,
        cursor: nextCursor,
        limit: 25,
      });
      setBoardFeed((prev) =>
        prev && prev.boardId === boardId && prev.sort === sort
          ? appendBoardFeedPage(prev, page)
          : prev,
      );
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : '加载更多帖子失败');
    } finally {
      setIsLoadingMorePosts(false);
    }
  };

  const handleLoadMoreComments = async () => {
    if (!postDetail || !postDetail.hasMore || !postDetail.nextCursor || isLoadingMoreComments) {
      return;
    }
    const targetPostId = postDetail.post.id;
    const cursor = postDetail.nextCursor;
    setIsLoadingMoreComments(true);
    try {
      const page = await api.listPostComments(targetPostId, {
        cursor,
        limit: 50,
      });
      setPostDetail((prev) =>
        prev && prev.post.id === targetPostId ? appendPostCommentsPage(prev, page) : prev,
      );
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : '加载更多评论失败');
    } finally {
      setIsLoadingMoreComments(false);
    }
  };

  const refreshAgentsManually = () => {
    void api
      .listAgents()
      .then(setAgents)
      .catch(() => {});
  };

  return (
    <div className="app-shell">
      <TopBar
        workspace={workspace}
        onSelectWorkspace={handleSelectWorkspace}
        groupCount={groups.length}
        boardCount={boards.length}
        forumPendingCount={forumPendingCount}
        agentCount={agents.length}
        apiHealthy={apiHealthy}
        wsStatus={wsStatus}
        isResyncing={groupStream?.isResyncing ?? false}
        isAgentDrawerOpen={isAgentDrawerOpen}
        onToggleAgentDrawer={() => setIsAgentDrawerOpen((v) => !v)}
      />

      {errorBanner && (
        <div className="error-banner" role="alert">
          <span>请求异常：{errorBanner}</span>
          <button type="button" className="ghost-btn" onClick={() => setErrorBanner(null)}>
            忽略
          </button>
        </div>
      )}

      {workspace === 'im' ? (
        <ImWorkspace
          groups={groups}
          activeGroupId={activeGroupId}
          onSelectGroup={setActiveGroupId}
          stream={groupStream}
          members={groupMembers}
          isLoadingSnapshot={isLoadingGroupSnapshot}
          isLoadingHistory={isLoadingGroupHistory}
          onLoadOlderHistory={handleLoadOlderGroupHistory}
          onFollowTailChange={handleFollowTailChange}
          agentsById={agentsById}
          onUnknownAgent={handleUnknownAgent}
        />
      ) : (
        <ForumWorkspace
          boards={boards}
          activeBoardId={activeBoardId}
          onSelectBoard={(bid) => {
            setActiveBoardId(bid);
            setActivePostId(null);
          }}
          feed={boardFeed}
          isLoadingFeed={isLoadingBoardFeed}
          isLoadingMorePosts={isLoadingMorePosts}
          onChangeSort={setBoardSort}
          onRefreshBoard={() => {
            if (activeBoardId) {
              void loadBoardPostsFirstPage(activeBoardId, boardSort);
              void api
                .listBoards()
                .then(setBoards)
                .catch(() => {});
            }
          }}
          onLoadMorePosts={() => void handleLoadMorePosts()}
          activePostId={activePostId}
          onSelectPost={setActivePostId}
          detail={postDetail}
          isLoadingDetail={isLoadingPostDetail}
          isLoadingMoreComments={isLoadingMoreComments}
          onLoadMoreComments={() => void handleLoadMoreComments()}
          agentsById={agentsById}
          onUnknownAgent={handleUnknownAgent}
        />
      )}

      {isAgentDrawerOpen && (
        <AgentDirectoryDrawer
          agents={agents}
          onRefresh={refreshAgentsManually}
          onClose={() => setIsAgentDrawerOpen(false)}
        />
      )}
    </div>
  );
}
