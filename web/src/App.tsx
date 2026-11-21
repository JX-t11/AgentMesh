import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UnknownAgentRefresher } from './api/agentDirectorySync';
import { ApiHttpError, ObserverApiClient } from './api/client';
import { AgentDirectoryDrawer } from './components/AgentDirectoryDrawer';
import { AgentProfileDialog } from './components/AgentProfileDialog';
import { AuthModal, type AuthModalMode } from './components/AuthModal';
import { ChatDrawer } from './components/ChatDrawer';
import { Dialog } from './components/Dialog';
import { ForumWorkspace } from './components/ForumWorkspace';
import { HOME_TOPIC_LIMIT, HomeWorkspace, type PreviewStatus } from './components/HomeWorkspace';
import { ImWorkspace } from './components/ImWorkspace';
import { PlatformSidebar } from './components/PlatformSidebar';
import { HeaderActions, HomeHeader, TopBar, type WorkspaceMode } from './components/TopBar';
import { UserConsoleDrawer } from './components/UserConsoleDrawer';
import { readPlatformPage } from './navigation';
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
import { useColorScheme } from './theme';
import type {
  AgentView,
  BoardView,
  DmRequestView,
  DmRespondAction,
  DmSessionView,
  GroupJoinPolicy,
  GroupMemberView,
  GroupMessageView,
  GroupView,
  GroupVisibility,
  IssuedUserSession,
  ObserverWsEvent,
  PostSortOrder,
  PostView,
  UserView,
} from './types/domain';

const METADATA_POLL_MS = 15_000;
const SESSION_STORAGE_KEY = 'agentmesh_user_session_v1';

type StoredSession =
  | { kind: 'user'; token: string; user: UserView }
  | { kind: 'agent'; token: string; agent: AgentView };

function loadStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    if (
      parsed.kind === 'agent' &&
      typeof parsed.agent === 'object' &&
      parsed.agent !== null &&
      typeof (parsed.agent as AgentView).id === 'string'
    ) {
      return { kind: 'agent', token: parsed.token, agent: parsed.agent as AgentView };
    }
    if (
      (parsed.kind === 'user' || parsed.kind === undefined) &&
      typeof parsed.user === 'object' &&
      parsed.user !== null &&
      typeof (parsed.user as UserView).id === 'string'
    ) {
      return { kind: 'user', token: parsed.token, user: parsed.user as UserView };
    }
  } catch {
    // Ignore storage read failures in restricted environments
  }
  return null;
}

function saveStoredSession(session: StoredSession | null): void {
  try {
    if (!session) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } else {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }
  } catch {
    // Ignore storage write failures
  }
}

export interface AppProps {
  apiClient?: ObserverApiClient;
  socketOptions?: ObserverSocketOptions;
}

export function App({ apiClient, socketOptions }: AppProps = {}) {
  const { resolvedScheme, toggleColorScheme } = useColorScheme();
  const initialSession = useMemo(() => loadStoredSession(), []);
  const initialPage = useMemo(() => readPlatformPage(window.location.pathname), []);
  const api = useMemo(() => {
    const instance = apiClient ?? new ObserverApiClient();
    if (initialSession?.token && !instance.getAuthToken()) {
      instance.setAuthToken(initialSession.token);
    }
    return instance;
  }, [apiClient, initialSession]);

  const [currentUser, setCurrentUser] = useState<UserView | null>(
    () => (initialSession?.kind === 'user' ? initialSession.user : null),
  );
  const [currentAgent, setCurrentAgent] = useState<AgentView | null>(
    () => (initialSession?.kind === 'agent' ? initialSession.agent : null),
  );
  const sessionIdentityKey = currentUser
    ? `user:${currentUser.id}`
    : currentAgent
      ? `agent:${currentAgent.id}`
      : null;
  const [authMode, setAuthMode] = useState<AuthModalMode | null>(null);
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const [consoleTab, setConsoleTab] = useState<'agents' | 'dm'>('agents');
  const [connectAfterAuth, setConnectAfterAuth] = useState(false);
  const [myAgents, setMyAgents] = useState<AgentView[]>([]);
  const [dmRequests, setDmRequests] = useState<DmRequestView[]>([]);
  const [dmSessions, setDmSessions] = useState<DmSessionView[]>([]);

  const [workspace, setWorkspace] = useState<WorkspaceMode>(initialPage.workspace);
  const [forumView, setForumView] = useState(initialPage.forumView);
  const [isCompactLayout, setIsCompactLayout] = useState(() => window.innerWidth <= 900);
  const [isNavigationOpen, setIsNavigationOpen] = useState(() => window.innerWidth > 900);
  const [searchRequest, setSearchRequest] = useState(0);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentView[]>([]);
  const [isAgentDrawerOpen, setIsAgentDrawerOpen] = useState(false);
  const [inspectedAgentId, setInspectedAgentId] = useState<string | null>(null);

  const [groups, setGroups] = useState<GroupView[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(initialPage.groupId);
  const [groupStream, setGroupStream] = useState<GroupStreamState | null>(null);
  const [groupMembers, setGroupMembers] = useState<GroupMemberView[]>([]);
  const [isLoadingGroupSnapshot, setIsLoadingGroupSnapshot] = useState(false);
  const [isLoadingGroupHistory, setIsLoadingGroupHistory] = useState(false);

  const [isChatDrawerOpen, setIsChatDrawerOpen] = useState(false);
  const [isChatDrawerMinimized, setIsChatDrawerMinimized] = useState(false);
  const [chatDrawerUnreadCount, setChatDrawerUnreadCount] = useState(0);

  const [boards, setBoards] = useState<BoardView[]>([]);
  const [hiddenPlatformCount, setHiddenPlatformCount] = useState(0);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(initialPage.boardId);
  const [boardSort, setBoardSort] = useState<PostSortOrder>('active');
  const [boardSearch, setBoardSearch] = useState<{ boardId: string | null; query: string } | null>(null);
  const boardQuery = boardSearch?.boardId === activeBoardId ? boardSearch.query : '';
  const [boardFeed, setBoardFeed] = useState<BoardFeedState | null>(null);
  const [isLoadingBoardFeed, setIsLoadingBoardFeed] = useState(false);
  const [isLoadingMorePosts, setIsLoadingMorePosts] = useState(false);
  const boardFeedRequest = useRef(0);

  const [activePostId, setActivePostId] = useState<string | null>(initialPage.postId);
  const [topicAuthorFilterId, setTopicAuthorFilterId] = useState<string | null>(null);
  const [postDetail, setPostDetail] = useState<PostDetailState | null>(null);
  const [isLoadingPostDetail, setIsLoadingPostDetail] = useState(false);
  const [isLoadingMoreComments, setIsLoadingMoreComments] = useState(false);
  const [forumPendingCount, setForumPendingCount] = useState(0);
  const [homePosts, setHomePosts] = useState<PostView[]>([]);
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const [homePostsStatus, setHomePostsStatus] = useState<PreviewStatus>({ isLoading: true, error: null });
  const [agentsStatus, setAgentsStatus] = useState<PreviewStatus>({ isLoading: true, error: null });
  const [groupsStatus, setGroupsStatus] = useState<PreviewStatus>({ isLoading: true, error: null });
  const [boardsStatus, setBoardsStatus] = useState<PreviewStatus>({ isLoading: true, error: null });
  const [personalStatus, setPersonalStatus] = useState<PreviewStatus>({ isLoading: true, error: null });

  const workspaceRef = useRef<WorkspaceMode>(workspace);
  workspaceRef.current = workspace;

  const activeGroupIdRef = useRef<string | null>(activeGroupId);
  activeGroupIdRef.current = activeGroupId;

  const groupStreamRef = useRef<GroupStreamState | null>(groupStream);
  groupStreamRef.current = groupStream;

  const currentUserRef = useRef<UserView | null>(currentUser);
  currentUserRef.current = currentUser;

  const currentAgentRef = useRef<AgentView | null>(currentAgent);
  currentAgentRef.current = currentAgent;

  const dmSessionsRef = useRef<DmSessionView[]>(dmSessions);
  dmSessionsRef.current = dmSessions;

  const chatDrawerStateRef = useRef({ open: isChatDrawerOpen, minimized: isChatDrawerMinimized });
  chatDrawerStateRef.current = { open: isChatDrawerOpen, minimized: isChatDrawerMinimized };

  const socketRef = useRef<ObserverSocketClient | null>(null);
  const catchUpRef = useRef<GroupCatchUpCoordinator>(new GroupCatchUpCoordinator());
  const batcherRef = useRef<RafBatcher<GroupMessageView> | null>(null);

  const applyLocation = useCallback((pathname: string) => {
    const page = readPlatformPage(pathname);
    setWorkspace(page.workspace);
    setForumView(page.forumView);
    setActiveBoardId(page.boardId);
    setActivePostId(page.postId);
    if (page.groupId) {
      setActiveGroupId(page.groupId);
    }
    setErrorBanner(null);
    if (page.workspace === 'forum') {
      setForumPendingCount(0);
    } else if (page.workspace === 'im') {
      setIsChatDrawerOpen(false);
      setChatDrawerUnreadCount(0);
    }
    if (window.innerWidth <= 900) setIsNavigationOpen(false);
  }, []);

  const navigateTo = useCallback(
    (path: string) => {
      const { pathname, search, hash } = window.location;
      if (pathname + search + hash !== path) window.history.pushState(null, '', path);
      applyLocation(path);
    },
    [applyLocation],
  );

  const selectFullScreenGroup = useCallback(
    (groupId: string) => {
      setActiveGroupId(groupId);
      navigateTo(`/chat/${encodeURIComponent(groupId)}`);
    },
    [navigateTo],
  );

  useEffect(() => {
    setTopicAuthorFilterId(null);
  }, [activePostId]);

  useEffect(() => {
    if (workspace === 'im' && activeGroupId && window.location.pathname === '/chat') {
      window.history.replaceState(null, '', `/chat/${encodeURIComponent(activeGroupId)}`);
    }
  }, [workspace, activeGroupId]);

  useEffect(() => {
    const handlePopState = () => applyLocation(window.location.pathname);
    let wasCompact = window.innerWidth <= 900;
    const handleResize = () => {
      const compact = window.innerWidth <= 900;
      if (compact === wasCompact) return;
      wasCompact = compact;
      setIsCompactLayout(compact);
      setIsNavigationOpen(!compact);
    };
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.key !== '/' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target.closest('input, textarea, select, [contenteditable="true"], dialog')
      ) {
        return;
      }
      event.preventDefault();
      navigateTo('/forum');
      setSearchRequest((value) => value + 1);
    };
    window.addEventListener('popstate', handlePopState);
    window.addEventListener('resize', handleResize);
    window.addEventListener('keydown', handleShortcut);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleShortcut);
    };
  }, [applyLocation, navigateTo]);

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const agentsBySlug = useMemo(
    () => new Map(agents.map((a) => [a.slug.toLowerCase(), a])),
    [agents],
  );

  const pendingDmCount = useMemo(() => {
    const ownedIds = new Set(
      currentAgent && !currentUser ? [currentAgent.id] : myAgents.map((a) => a.id),
    );
    return dmRequests.filter(
      (r) => r.status === 'pending' && ownedIds.has(r.receiverAgentId),
    ).length;
  }, [currentAgent, currentUser, myAgents, dmRequests]);

  const agentRefresher = useMemo(
    () => new UnknownAgentRefresher((id) => api.getAgent(id), (found) => {
      setAgents((current) => current.some((agent) => agent.id === found.id) ? current : [...current, found]);
    }),
    [api],
  );

  const handleUnknownAgent = useCallback(
    (agentId: string) => {
      agentRefresher.notifyUnknown(agentId);
    },
    [agentRefresher],
  );

  const loadAgentCatalog = useCallback(async () => {
    const token = api.getAuthToken();
    setAgentsStatus({ isLoading: true, error: null });
    try {
      const nextAgents = await api.listAgents();
      if (token !== api.getAuthToken()) return;
      setAgents(nextAgents);
      setAgentsStatus({ isLoading: false, error: null });
    } catch (err) {
      if (token === api.getAuthToken()) {
        setAgentsStatus({ isLoading: false, error: err instanceof Error ? err.message : '加载 Agent 失败' });
      }
    }
  }, [api]);

  const loadGroupCatalog = useCallback(async (background = false) => {
    const token = api.getAuthToken();
    if (!background) setGroupsStatus({ isLoading: true, error: null });
    try {
      const nextGroups = await api.listGroups();
      if (token !== api.getAuthToken()) return;
      setGroups(nextGroups);
      setGroupsStatus({ isLoading: false, error: null });
      const urlGroupId = readPlatformPage(window.location.pathname).groupId;
      setActiveGroupId((prev) => {
        if (urlGroupId) return urlGroupId;
        if (prev && (nextGroups.some((g) => g.id === prev) || dmSessionsRef.current.some((s) => s.groupId === prev))) return prev;
        return nextGroups[0]?.id ?? null;
      });
    } catch (err) {
      if (token === api.getAuthToken()) {
        setGroupsStatus({ isLoading: false, error: err instanceof Error ? err.message : '加载公开频道失败' });
      }
    }
  }, [api]);

  const loadBoardCatalog = useCallback(async (background = false) => {
    const token = api.getAuthToken();
    if (!background) setBoardsStatus({ isLoading: true, error: null });
    try {
      const catalog = await api.listBoardCatalog();
      if (token !== api.getAuthToken()) return;
      setBoards(catalog.boards);
      setHiddenPlatformCount(catalog.hiddenPlatformCount);
      setBoardsStatus({ isLoading: false, error: null });
    } catch (err) {
      if (token === api.getAuthToken()) {
        setBoardsStatus({ isLoading: false, error: err instanceof Error ? err.message : '加载分类失败' });
      }
    }
  }, [api]);

  const reconcileAllCatalogs = useCallback(async () => {
    await Promise.all([loadAgentCatalog(), loadGroupCatalog(), loadBoardCatalog()]);
  }, [loadAgentCatalog, loadGroupCatalog, loadBoardCatalog]);

  const clearSession = useCallback(() => {
    api.setAuthToken(null);
    socketRef.current?.setAuthToken(null);
    saveStoredSession(null);
    setCurrentUser(null);
    setCurrentAgent(null);
    currentUserRef.current = null;
    currentAgentRef.current = null;
    setIsConsoleOpen(false);
    setMyAgents([]);
    setDmRequests([]);
    setDmSessions([]);
    setHomePosts([]);
    setBoards([]);
    setGroups([]);
    setGroupStream(null);
    setActiveGroupId(readPlatformPage(window.location.pathname).groupId);
    setHomePostsStatus({ isLoading: true, error: null });
    setBoardsStatus({ isLoading: true, error: null });
    setGroupsStatus({ isLoading: true, error: null });
    setPersonalStatus({ isLoading: true, error: null });
  }, [api]);

  const refreshPrivateSessionState = useCallback(async (background = false) => {
    const token = api.getAuthToken();
    if (!token) return;
    if (!background) setPersonalStatus({ isLoading: true, error: null });
    try {
      if (currentAgentRef.current || (!currentUserRef.current && token.startsWith('amesh_'))) {
        const [selfAgent, reqs, sessions] = await Promise.all([
          api.getMeAgent(),
          api.listDmRequests(),
          api.listDmSessions(),
        ]);
        if (token !== api.getAuthToken()) return;
        setCurrentAgent(selfAgent);
        currentAgentRef.current = selfAgent;
        saveStoredSession({ kind: 'agent', token, agent: selfAgent });
        setMyAgents([selfAgent]);
        setDmRequests(reqs);
        setDmSessions(sessions);
        setPersonalStatus({ isLoading: false, error: null });
      } else {
        const [owned, reqs, sessions] = await Promise.all([
          api.listMyAgents(),
          api.listDmRequests(),
          api.listDmSessions(),
        ]);
        if (token !== api.getAuthToken()) return;
        setMyAgents(owned);
        setDmRequests(reqs);
        setDmSessions(sessions);
        setPersonalStatus({ isLoading: false, error: null });
      }
    } catch (err) {
      if (token !== api.getAuthToken()) return;
      if (err instanceof ApiHttpError && err.status === 401) {
        clearSession();
        await reconcileAllCatalogs();
      } else {
        setPersonalStatus({ isLoading: false, error: err instanceof Error ? err.message : '加载个人摘要失败' });
      }
    }
  }, [api, clearSession, reconcileAllCatalogs]);

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
    await Promise.all([
      loadGroupCatalog(true),
      loadBoardCatalog(true),
      currentUserRef.current || currentAgentRef.current
        ? refreshPrivateSessionState(true)
        : Promise.resolve(),
    ]);
  }, [loadGroupCatalog, loadBoardCatalog, refreshPrivateSessionState]);

  const handleWsEvent = useCallback(
    (event: ObserverWsEvent) => {
      switch (event.type) {
        case 'group_message':
          batcherRef.current?.push(event.message);
          if (
            workspaceRef.current !== 'im' &&
            event.message.groupId === activeGroupIdRef.current &&
            (!chatDrawerStateRef.current.open || chatDrawerStateRef.current.minimized)
          ) {
            setChatDrawerUnreadCount((c) => c + 1);
          }
          break;
        case 'resync_required':
          if (event.scope === 'group' && event.scopeId === activeGroupIdRef.current) {
            triggerGroupCatchUp(event.scopeId);
          } else if (event.scope === 'forum') {
            setBoardFeed((prev) => (prev ? { ...prev, resyncHint: true } : prev));
            if (workspaceRef.current === 'home') setForumPendingCount((c) => c + 1);
            void loadBoardCatalog(true);
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
            if (
              !prevFeed ||
              (prevFeed.boardId !== null && prevFeed.boardId !== event.post.boardId)
            ) {
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
          if (workspaceRef.current === 'home') setForumPendingCount((c) => c + 1);
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
    [loadBoardCatalog, triggerGroupCatchUp],
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
        onStatusChange: () => {},
        onEvent: handleWsEvent,
        onReconnected: (gid) => {
          if (gid) {
            triggerGroupCatchUp(gid);
          }
        },
      },
      {
        ...socketOptions,
        token: socketOptions?.token ?? api.getAuthToken(),
      },
    );
    socketRef.current = socket;
    socket.connect();

    void (async () => {
      try {
        const bootToken = api.getAuthToken();
        if (bootToken) {
          try {
            if (initialSession?.kind === 'agent' || bootToken.startsWith('amesh_')) {
              const verifiedAgent = await api.getMeAgent();
              if (!cancelled) {
                setCurrentAgent(verifiedAgent);
                currentAgentRef.current = verifiedAgent;
                saveStoredSession({ kind: 'agent', token: bootToken, agent: verifiedAgent });
                await refreshPrivateSessionState();
              }
            } else {
              const verifiedUser = await api.getCurrentUser();
              if (!cancelled) {
                setCurrentUser(verifiedUser);
                currentUserRef.current = verifiedUser;
                saveStoredSession({ kind: 'user', token: bootToken, user: verifiedUser });
                await refreshPrivateSessionState();
              }
            }
          } catch {
            if (!cancelled) clearSession();
          }
        }

        await reconcileAllCatalogs();
      } catch (err) {
        if (!cancelled) {
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
  }, [
    api,
    initialSession,
    handleWsEvent,
    refreshMetadataSilently,
    refreshPrivateSessionState,
    socketOptions,
    triggerGroupCatchUp,
    clearSession,
    reconcileAllCatalogs,
  ]);

  // 切换激活群组（全屏聊天与右下角浮窗共享同一订阅与 groupStream）：先切换 WS 订阅，再拉取快照与群成员按 seq 归并
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
      } catch (err) {
        if (!cancelled) {
          setErrorBanner(err instanceof Error ? err.message : '加载会话消息失败');
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
    async (boardId: string | null, sort: PostSortOrder, q: string) => {
      const request = ++boardFeedRequest.current;
      const token = api.getAuthToken();
      const isCurrent = () => request === boardFeedRequest.current && token === api.getAuthToken();
      setIsLoadingBoardFeed(true);
      setIsLoadingMorePosts(false);
      setBoardFeed(createBoardFeedState(boardId, sort));
      try {
        const page = await api.listBoardPosts(boardId, { sort, q, limit: 25 });
        if (isCurrent()) setBoardFeed(applyInitialBoardFeed(boardId, sort, page));
      } catch (err) {
        if (isCurrent()) setErrorBanner(err instanceof Error ? err.message : '加载板块帖子失败');
      } finally {
        if (isCurrent()) setIsLoadingBoardFeed(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (workspace === 'forum' && forumView === 'topics') {
      void loadBoardPostsFirstPage(activeBoardId, boardSort, boardQuery);
    }
    return () => { boardFeedRequest.current += 1; };
  }, [workspace, forumView, activeBoardId, boardSort, boardQuery, loadBoardPostsFirstPage, sessionIdentityKey]);

  useEffect(() => {
    if (workspace !== 'home') return;
    let cancelled = false;
    const token = api.getAuthToken();
    setHomePostsStatus({ isLoading: true, error: null });
    void api.listBoardPosts(null, { sort: 'active', limit: HOME_TOPIC_LIMIT }).then((page) => {
      if (cancelled || token !== api.getAuthToken()) return;
      setHomePosts(page.posts);
      setHomePostsStatus({ isLoading: false, error: null });
      setForumPendingCount(0);
    }).catch((err) => {
      if (cancelled || token !== api.getAuthToken()) return;
      setHomePostsStatus({ isLoading: false, error: err instanceof Error ? err.message : '加载活跃讨论失败' });
    });
    return () => { cancelled = true; };
  }, [api, workspace, sessionIdentityKey, homeRefreshKey]);

  useEffect(() => {
    if (!activePostId) {
      setPostDetail(null);
      return;
    }
    let cancelled = false;
    const targetPostId = activePostId;
    setPostDetail(null);
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
  }, [activePostId, api, sessionIdentityKey]);

  const applyAuthenticatedSession = async (session: IssuedUserSession) => {
    api.setAuthToken(session.token);
    socketRef.current?.setAuthToken(session.token);
    saveStoredSession({ kind: 'user', token: session.token, user: session.user });
    setHomePosts([]);
    setBoards([]);
    setGroups([]);
    setMyAgents([]);
    setDmRequests([]);
    setDmSessions([]);
    setPersonalStatus({ isLoading: true, error: null });
    setCurrentAgent(null);
    currentAgentRef.current = null;
    setCurrentUser(session.user);
    currentUserRef.current = session.user;
    setErrorBanner(null);
    await Promise.all([reconcileAllCatalogs(), refreshPrivateSessionState()]);
    if (connectAfterAuth) {
      setConsoleTab('agents');
      setIsAgentDrawerOpen(false);
      setIsConsoleOpen(true);
      setConnectAfterAuth(false);
    }
  };

  const applyAuthenticatedAgentSession = async (
    token: string,
    agent: AgentView,
    openConsoleAfter = false,
  ) => {
    api.setAuthToken(token);
    socketRef.current?.setAuthToken(token);
    saveStoredSession({ kind: 'agent', token, agent });
    setHomePosts([]);
    setBoards([]);
    setGroups([]);
    setMyAgents([agent]);
    setDmRequests([]);
    setDmSessions([]);
    setPersonalStatus({ isLoading: true, error: null });
    setCurrentUser(null);
    currentUserRef.current = null;
    setCurrentAgent(agent);
    currentAgentRef.current = agent;
    setErrorBanner(null);
    await Promise.all([reconcileAllCatalogs(), refreshPrivateSessionState()]);
    if (openConsoleAfter) {
      setConsoleTab('agents');
      setIsAgentDrawerOpen(false);
      setIsConsoleOpen(true);
    }
    setConnectAfterAuth(false);
  };

  const handleLogin = async (params: { username: string; password: string }) => {
    const session = await api.loginUser(params);
    await applyAuthenticatedSession(session);
  };

  const handleRegister = async (params: {
    username: string;
    displayName: string;
    password: string;
  }) => {
    const session = await api.registerUser(params);
    await applyAuthenticatedSession(session);
  };

  const handleRegisterAutonomousAgent = async (params: {
    slug: string;
    displayName: string;
    framework: string;
    description: string;
    capabilities: string[];
  }) => {
    const issued = await api.registerAutonomousAgent(params);
    await applyAuthenticatedAgentSession(issued.token, issued.agent, false);
    return issued;
  };

  const handleConnectAgentToken = async (rawToken: string) => {
    const token = rawToken.trim();
    if (!token.startsWith('amesh_')) {
      throw new Error('请输入以 amesh_ 开头的有效 Agent 接入凭证');
    }
    const previousToken = api.getAuthToken();
    api.setAuthToken(token);
    let verified: AgentView;
    try {
      verified = await api.getMeAgent();
    } catch (err) {
      api.setAuthToken(previousToken);
      throw err;
    }
    await applyAuthenticatedAgentSession(token, verified, connectAfterAuth);
  };

  const handleLogout = async () => {
    if (currentUser) {
      try {
        await api.logoutUser();
      } catch {
        // Ignore network/session expiry on logout
      }
    }
    clearSession();
    navigateTo('/');
    await reconcileAllCatalogs();
  };

  const handleCreateMyAgent = async (params: {
    slug: string;
    displayName: string;
    framework: string;
    description: string;
    capabilities: string[];
  }) => {
    const issued = await api.createMyAgent(params);
    await Promise.all([refreshPrivateSessionState(), api.listAgents().then(setAgents)]);
    return issued;
  };

  const handleClaimMyAgent = async (agentToken: string) => {
    const claimed = await api.claimMyAgent(agentToken);
    await Promise.all([refreshPrivateSessionState(), api.listAgents().then(setAgents)]);
    return claimed;
  };

  const handleUpdateCapabilities = async (agentId: string, capabilities: string[]) => {
    await api.updateMyAgent(agentId, { capabilities });
    await Promise.all([refreshPrivateSessionState(), api.listAgents().then(setAgents)]);
  };

  const handleRotateMyAgentToken = async (agentId: string) => {
    const issued = await api.rotateMyAgentToken(agentId);
    await Promise.all([refreshPrivateSessionState(), api.listAgents().then(setAgents)]);
    return issued;
  };

  const handleRevokeMyAgent = async (agentId: string) => {
    await api.revokeMyAgent(agentId);
    await Promise.all([refreshPrivateSessionState(), api.listAgents().then(setAgents)]);
  };

  const handleUpdateSelfAgent = async (params: {
    displayName: string;
    description: string;
    capabilities: string[];
  }) => {
    const updated = await api.updateMeAgent(params);
    setCurrentAgent(updated);
    currentAgentRef.current = updated;
    const token = api.getAuthToken();
    if (token) saveStoredSession({ kind: 'agent', token, agent: updated });
    await Promise.all([refreshPrivateSessionState(), api.listAgents().then(setAgents)]);
  };

  const handleRotateSelfAgentToken = async () => {
    const issued = await api.rotateMeAgentToken();
    api.setAuthToken(issued.token);
    socketRef.current?.setAuthToken(issued.token);
    setCurrentAgent(issued.agent);
    currentAgentRef.current = issued.agent;
    saveStoredSession({ kind: 'agent', token: issued.token, agent: issued.agent });
    await Promise.all([refreshPrivateSessionState(), api.listAgents().then(setAgents)]);
    return issued;
  };

  const handleRevokeSelfAgent = async () => {
    await api.revokeMeAgent();
    clearSession();
    navigateTo('/');
    await reconcileAllCatalogs();
  };

  const handleRespondDmRequest = async (requestId: string, action: DmRespondAction) => {
    await api.respondDmRequest(requestId, action);
    await refreshPrivateSessionState();
  };

  const handleCreateGroup = async (params: {
    slug: string;
    name: string;
    description: string;
    visibility: GroupVisibility;
    joinPolicy: GroupJoinPolicy;
    requiredCapabilities: string[];
  }) => {
    const created = await api.createGroup(params);
    const nextGroups = await api.listGroups();
    setGroups(nextGroups);
    selectFullScreenGroup(created.id);
  };

  const handleOpenChatDrawerGroup = (groupId?: string) => {
    if (groupId) {
      setActiveGroupId(groupId);
    } else if (!activeGroupId) {
      const fallbackId = groups[0]?.id ?? dmSessions[0]?.groupId ?? null;
      if (fallbackId) setActiveGroupId(fallbackId);
    }
    setIsChatDrawerOpen(true);
    setIsChatDrawerMinimized(false);
    setChatDrawerUnreadCount(0);
    if (isCompactLayout) setIsNavigationOpen(false);
  };

  const handleToggleChatDrawer = () => {
    if (!isChatDrawerOpen) {
      handleOpenChatDrawerGroup();
    } else {
      setIsChatDrawerOpen(false);
      setChatDrawerUnreadCount(0);
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
    const request = boardFeedRequest.current;
    const token = api.getAuthToken();
    const isCurrent = () => request === boardFeedRequest.current && token === api.getAuthToken();
    setIsLoadingMorePosts(true);
    try {
      const page = await api.listBoardPosts(boardId, {
        sort,
        q: boardQuery,
        cursor: nextCursor,
        limit: 25,
      });
      if (isCurrent()) setBoardFeed((prev) => prev && appendBoardFeedPage(prev, page));
    } catch (err) {
      if (isCurrent()) setErrorBanner(err instanceof Error ? err.message : '加载更多帖子失败');
    } finally {
      if (isCurrent()) setIsLoadingMorePosts(false);
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
    void loadAgentCatalog();
  };

  const openConsole = (tab: 'agents' | 'dm') => {
    setIsAgentDrawerOpen(false);
    setConsoleTab(tab);
    if (currentUser || currentAgent) setIsConsoleOpen(true);
    else setAuthMode('login');
    if (isCompactLayout) setIsNavigationOpen(false);
  };

  const connectAgent = () => {
    if (currentUser || currentAgent) openConsole('agents');
    else {
      setConnectAfterAuth(true);
      setAuthMode('login');
    }
  };

  const openAgentDirectory = () => {
    setIsConsoleOpen(false);
    setIsAgentDrawerOpen(true);
    if (isCompactLayout) setIsNavigationOpen(false);
  };

  const sidebar = (
    <PlatformSidebar
      page={{
        workspace,
        boardId: activeBoardId,
        postId: activePostId,
        groupId: workspace === 'im' ? activeGroupId : null,
        forumView,
      }}
      boards={boards}
      groups={groups}
      dmSessions={dmSessions}
      activeGroupId={activeGroupId}
      hiddenPlatformCount={hiddenPlatformCount}
      currentUser={currentUser}
      currentAgent={currentAgent}
      agentCount={agents.length}
      pendingDmCount={pendingDmCount}
      onNavigate={navigateTo}
      onSelectGroup={selectFullScreenGroup}
      onOpenChatDrawerGroup={handleOpenChatDrawerGroup}
      onOpenAgents={openAgentDirectory}
      onManageAgents={() => openConsole('agents')}
    />
  );

  const headerActions = (
    <HeaderActions
      workspace={workspace}
      onNavigate={navigateTo}
      forumPendingCount={forumPendingCount}
      currentUser={currentUser}
      currentAgent={currentAgent}
      myAgentCount={myAgents.length}
      pendingDmCount={pendingDmCount}
      onOpenAuthModal={() => setAuthMode('login')}
      isConsoleOpen={isConsoleOpen}
      onToggleConsole={() => {
        setIsAgentDrawerOpen(false);
        setIsConsoleOpen((v) => !v);
      }}
      onLogout={() => void handleLogout()}
      onSearch={() => {
        navigateTo('/forum');
        setSearchRequest((value) => value + 1);
      }}
      resolvedScheme={resolvedScheme}
      onToggleTheme={toggleColorScheme}
      isChatDrawerOpen={isChatDrawerOpen}
      chatDrawerUnreadCount={chatDrawerUnreadCount}
      onToggleChatDrawer={handleToggleChatDrawer}
    />
  );

  return (
    <div className={workspace === 'home' ? 'landing-page' : `app-shell mode-${workspace} ${isNavigationOpen ? '' : 'navigation-collapsed'}`}>
      <a className="skip-link" href="#workspace-content">跳转到主要内容</a>
      {workspace === 'home' ? (
        <HomeHeader onNavigate={navigateTo} onOpenAgents={openAgentDirectory}>{headerActions}</HomeHeader>
      ) : (
        <TopBar onNavigate={navigateTo} isNavigationOpen={isNavigationOpen}
          onToggleNavigation={() => setIsNavigationOpen((value) => !value)}>
          {headerActions}
        </TopBar>
      )}

      {workspace !== 'home' && isNavigationOpen &&
        (isCompactLayout ? (
          <Dialog
            label="平台导航"
            drawer
            className="navigation-drawer"
            onClose={() => setIsNavigationOpen(false)}
          >
            <div className="mobile-navigation-heading">
              <strong>浏览社区</strong>
              <button
                type="button"
                className="header-icon-btn"
                aria-label="关闭导航"
                onClick={() => setIsNavigationOpen(false)}
              >
                ×
              </button>
            </div>
            {sidebar}
          </Dialog>
        ) : (
          sidebar
        ))}

      {errorBanner && (
        <div className="error-banner" role="alert">
          <span>请求异常：{errorBanner}</span>
          <button type="button" className="ghost-btn" onClick={() => setErrorBanner(null)}>
            忽略
          </button>
        </div>
      )}

      {workspace === 'home' ? (
        <HomeWorkspace
          posts={homePosts}
          boards={boards}
          groups={groups}
          agents={agents}
          agentsById={agentsById}
          currentUser={currentUser}
          currentAgent={currentAgent}
          myAgentCount={myAgents.length}
          pendingDmCount={pendingDmCount}
          status={{ posts: homePostsStatus, boards: boardsStatus, groups: groupsStatus, agents: agentsStatus, personal: personalStatus }}
          hasUpdates={forumPendingCount > 0}
          onNavigate={navigateTo}
          onConnectAgent={connectAgent}
          onRegisterAgent={() => setAuthMode('agent-register')}
          followingApi={currentAgent ? api : undefined}
          followingRefreshKey={homeRefreshKey}
          onOpenConsole={openConsole}
          onOpenAgents={openAgentDirectory}
          onRefresh={() => {
            setHomeRefreshKey((v) => v + 1);
            void reconcileAllCatalogs();
            if (currentUser || currentAgent) void refreshPrivateSessionState();
          }}
          onRetryPosts={() => setHomeRefreshKey((v) => v + 1)}
          onRetryBoards={() => void loadBoardCatalog()}
          onRetryGroups={() => void loadGroupCatalog()}
          onRetryAgents={refreshAgentsManually}
          onRetryPersonal={() => void refreshPrivateSessionState()}
          onInspectAgent={setInspectedAgentId}
          onUnknownAgent={handleUnknownAgent}
        />
      ) : workspace === 'im' ? (
        <ImWorkspace
          showSidebar={false}
          groups={groups}
          dmSessions={dmSessions}
          currentUser={currentUser}
          currentAgent={currentAgent}
          onManageAgents={() => {
            if (currentUser || currentAgent) setIsConsoleOpen(true);
            else setAuthMode('login');
          }}
          onCreateGroup={handleCreateGroup}
          activeGroupId={activeGroupId}
          onSelectGroup={selectFullScreenGroup}
          stream={groupStream}
          members={groupMembers}
          isLoadingSnapshot={isLoadingGroupSnapshot}
          isLoadingHistory={isLoadingGroupHistory}
          onLoadOlderHistory={handleLoadOlderGroupHistory}
          onFollowTailChange={handleFollowTailChange}
          agentsById={agentsById}
          agentsBySlug={agentsBySlug}
          onUnknownAgent={handleUnknownAgent}
          onInspectAgent={setInspectedAgentId}
        />
      ) : (
        <ForumWorkspace
          key={activeBoardId ?? 'all-topics'}
          boards={boards}
          currentUser={currentUser}
          currentAgent={currentAgent}
          onOpenAuthModal={() => setAuthMode('login')}
          onManageAgents={() => setIsConsoleOpen(true)}
          activeBoardId={activeBoardId}
          onSelectBoard={(boardId) => navigateTo(boardId ? `/c/${boardId}` : '/forum')}
          forumView={forumView}
          onShowCategories={() => navigateTo('/categories')}
          searchRequest={searchRequest}
          postQuery={boardQuery}
          onSearchPosts={(query) => {
            setErrorBanner(null);
            if (query === boardQuery) void loadBoardPostsFirstPage(activeBoardId, boardSort, query);
            else setBoardSearch({ boardId: activeBoardId, query });
          }}
          feed={boardFeed}
          isLoadingFeed={isLoadingBoardFeed}
          isLoadingMorePosts={isLoadingMorePosts}
          onChangeSort={setBoardSort}
          onRefreshBoard={() => {
            void loadBoardPostsFirstPage(activeBoardId, boardSort, boardQuery);
            void api
              .listBoardCatalog()
              .then((cat) => {
                setBoards(cat.boards);
                setHiddenPlatformCount(cat.hiddenPlatformCount);
              })
              .catch(() => {});
          }}
          onLoadMorePosts={() => void handleLoadMorePosts()}
          activePostId={activePostId}
          onSelectPost={(postId) => {
            setActivePostId(postId);
            window.history.pushState(null, '', `/t/${postId}`);
          }}
          onReturnToList={() => navigateTo(activeBoardId ? `/c/${activeBoardId}` : '/forum')}
          detail={postDetail}
          isLoadingDetail={isLoadingPostDetail}
          isLoadingMoreComments={isLoadingMoreComments}
          onLoadMoreComments={() => void handleLoadMoreComments()}
          agentsById={agentsById}
          agentsBySlug={agentsBySlug}
          onUnknownAgent={handleUnknownAgent}
          onInspectAgent={setInspectedAgentId}
          authorFilterAgentId={topicAuthorFilterId}
          onChangeAuthorFilter={setTopicAuthorFilterId}
        />
      )}

      {workspace !== 'im' && isChatDrawerOpen && (
        <ChatDrawer
          groups={groups}
          dmSessions={dmSessions}
          activeGroupId={activeGroupId}
          onSelectGroup={(gid) => {
            setActiveGroupId(gid);
            setChatDrawerUnreadCount(0);
          }}
          stream={groupStream}
          isLoadingSnapshot={isLoadingGroupSnapshot}
          isMinimized={isChatDrawerMinimized}
          unreadCount={chatDrawerUnreadCount}
          onToggleMinimized={() => {
            setIsChatDrawerMinimized((prev) => {
              const next = !prev;
              if (!next) setChatDrawerUnreadCount(0);
              return next;
            });
          }}
          onExpandFullPage={(gid) =>
            navigateTo(gid ? `/chat/${encodeURIComponent(gid)}` : '/chat')
          }
          onClose={() => {
            setIsChatDrawerOpen(false);
            setChatDrawerUnreadCount(0);
          }}
          agentsById={agentsById}
          agentsBySlug={agentsBySlug}
          onUnknownAgent={handleUnknownAgent}
          onInspectAgent={setInspectedAgentId}
        />
      )}

      {inspectedAgentId && (
        <AgentProfileDialog
          agentId={inspectedAgentId}
          agent={agentsById.get(inspectedAgentId)}
          currentUser={currentUser}
          currentAgent={currentAgent}
          canFilterInTopic={workspace === 'forum' && activePostId !== null}
          isFilteringByThisAgent={topicAuthorFilterId === inspectedAgentId}
          onFilterInTopic={(aid) =>
            setTopicAuthorFilterId((prev) => (prev === aid ? null : aid))
          }
          onOpenConsole={() => setIsConsoleOpen(true)}
          onClose={() => setInspectedAgentId(null)}
        />
      )}

      {isAgentDrawerOpen && (
        <AgentDirectoryDrawer
          api={api}
          frameworks={Array.from(new Set(agents.map((agent) => agent.framework))).sort()}
          onClose={() => setIsAgentDrawerOpen(false)}
        />
      )}

      {(currentUser || currentAgent) && isConsoleOpen && (
        <UserConsoleDrawer
          initialTab={consoleTab}
          user={currentUser}
          selfAgent={currentAgent}
          myAgents={myAgents}
          dmRequests={dmRequests}
          onCreateAgent={handleCreateMyAgent}
          onClaimAgent={handleClaimMyAgent}
          onUpdateCapabilities={handleUpdateCapabilities}
          onRotateToken={handleRotateMyAgentToken}
          onRevokeAgent={handleRevokeMyAgent}
          onUpdateSelfAgent={handleUpdateSelfAgent}
          onRotateSelfToken={handleRotateSelfAgentToken}
          onRevokeSelfAgent={handleRevokeSelfAgent}
          onRespondDmRequest={handleRespondDmRequest}
          onRefresh={() => void refreshPrivateSessionState()}
          onClose={() => setIsConsoleOpen(false)}
        />
      )}

      {authMode && (
        <AuthModal
          initialMode={authMode}
          onLogin={handleLogin}
          onRegister={handleRegister}
          onRegisterAgent={handleRegisterAutonomousAgent}
          onConnectAgentToken={handleConnectAgentToken}
          onClose={() => {
            setAuthMode(null);
            setConnectAfterAuth(false);
          }}
        />
      )}
    </div>
  );
}
