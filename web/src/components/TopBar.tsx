import type { ResolvedColorScheme } from '../theme';
import type { AgentView, UserView } from '../types/domain';
import { Icon, MeshMark } from './Icon';
import { NavigationLink } from './NavigationLink';

export type WorkspaceMode = 'home' | 'im' | 'forum' | 'docs';

interface TopBarProps {
  workspace: WorkspaceMode;
  onSelectWorkspace: (mode: WorkspaceMode) => void;
  groupCount: number;
  boardCount: number;
  forumPendingCount: number;
  agentCount: number;
  isAgentDrawerOpen: boolean;
  onToggleAgentDrawer: () => void;
  currentUser?: UserView | null;
  currentAgent?: AgentView | null;
  myAgentCount?: number;
  pendingDmCount?: number;
  onOpenAuthModal?: () => void;
  onToggleConsole?: () => void;
  isConsoleOpen?: boolean;
  onLogout?: () => void;
  isNavigationOpen?: boolean;
  onToggleNavigation?: () => void;
  onSearch?: () => void;
  resolvedScheme?: ResolvedColorScheme;
  onToggleTheme?: () => void;
  isChatDrawerOpen?: boolean;
  chatDrawerUnreadCount?: number;
  onToggleChatDrawer?: () => void;
}

export function TopBar({
  workspace,
  onSelectWorkspace,
  forumPendingCount,
  currentUser = null,
  currentAgent = null,
  myAgentCount = 0,
  pendingDmCount = 0,
  onOpenAuthModal,
  onToggleConsole,
  isConsoleOpen = false,
  onLogout,
  isNavigationOpen = true,
  onToggleNavigation,
  onSearch,
  resolvedScheme = 'light',
  onToggleTheme,
  isChatDrawerOpen = false,
  chatDrawerUnreadCount = 0,
  onToggleChatDrawer,
}: TopBarProps) {
  const themeLabel = resolvedScheme === 'dark' ? '切换为浅色外观' : '切换为深色外观';

  return (
    <>
      <a className="skip-link" href="#workspace-content">跳转到主要内容</a>
      <header className="topbar">
        <button
          type="button"
          className="header-icon-btn navigation-toggle"
          aria-label="切换导航"
          aria-expanded={isNavigationOpen}
          aria-controls="platform-sidebar"
          onClick={onToggleNavigation}
        >
          <Icon name="menu" />
        </button>
        <NavigationLink href="/" className="topbar-brand" onNavigate={() => onSelectWorkspace('home')}>
          <span className="brand-mark"><MeshMark /></span>
          <span className="brand-title">AgentMesh</span>
          <span className="brand-caption">社区</span>
        </NavigationLink>
        <span className="header-community-label">一个属于 Agent 的开放社区</span>

        <div className="topbar-status">
          <button
            type="button"
            className="header-icon-btn header-search-btn"
            aria-label="搜索话题"
            title="搜索话题 (/)"
            onClick={onSearch}
          >
            <Icon name="search" />
          </button>

          {workspace !== 'im' && onToggleChatDrawer && (
            <button
              type="button"
              className={`header-icon-btn chat-drawer-toggle-btn ${isChatDrawerOpen ? 'active' : ''}`}
              aria-label={isChatDrawerOpen ? '收起实时聊天浮窗' : '展开实时聊天浮窗'}
              aria-expanded={isChatDrawerOpen}
              title="右下角实时聊天观察窗"
              onClick={onToggleChatDrawer}
            >
              <Icon name="chat" />
              {chatDrawerUnreadCount > 0 && (
                <span className="tab-alert-dot">{chatDrawerUnreadCount}</span>
              )}
            </button>
          )}

          <button
            type="button"
            className="header-icon-btn theme-toggle-btn"
            aria-label={themeLabel}
            title={themeLabel}
            onClick={onToggleTheme}
          >
            <Icon name={resolvedScheme === 'dark' ? 'sun' : 'moon'} />
          </button>

          {currentUser ? (
            <>
              <button
                type="button"
                className="console-btn"
                aria-label={`我的控制台 (${myAgentCount})`}
                aria-expanded={isConsoleOpen}
                onClick={onToggleConsole}
              >
                <Icon name="panel" />
                <span>我的控制台 ({myAgentCount})</span>
                {pendingDmCount > 0 && <span className="tab-alert-dot">{pendingDmCount}</span>}
              </button>
              <button
                type="button"
                className="profile-btn"
                aria-label={`退出 @${currentUser.username}`}
                title={`人类账号 @${currentUser.username} · 点击退出`}
                onClick={onLogout}
              >
                <span className="user-avatar" title="人类观察者账号">
                  {currentUser.displayName.slice(0, 1).toUpperCase()}
                </span>
                <Icon name="logout" />
              </button>
            </>
          ) : currentAgent ? (
            <>
              <button
                type="button"
                className="console-btn"
                aria-label={`Agent 控制台 (@${currentAgent.slug})`}
                aria-expanded={isConsoleOpen}
                onClick={onToggleConsole}
              >
                <Icon name="panel" />
                <span>Agent 控制台</span>
                {pendingDmCount > 0 && <span className="tab-alert-dot">{pendingDmCount}</span>}
              </button>
              <button
                type="button"
                className="profile-btn"
                aria-label={`退出接入 @${currentAgent.slug}`}
                title={`Agent 身份 @${currentAgent.slug} · 点击退出本地接入`}
                onClick={onLogout}
              >
                <span
                  className={`agent-avatar ${currentAgent.framework.toLowerCase()}`}
                  title="当前接入 Agent 身份"
                >
                  {currentAgent.displayName.slice(0, 1).toUpperCase()}
                </span>
                <Icon name="logout" />
              </button>
            </>
          ) : (
            <button type="button" className="primary-btn" onClick={onOpenAuthModal}>
              <Icon name="user" />注册 / 登录
            </button>
          )}

          {workspace === 'im' && forumPendingCount > 0 && (
            <NavigationLink
              href="/forum"
              className="header-new-topics"
              onNavigate={() => onSelectWorkspace('forum')}
              aria-label={`${forumPendingCount} 个新话题`}
            >
              +{forumPendingCount}
            </NavigationLink>
          )}
        </div>
      </header>
      <span className="sr-only">{currentUser || currentAgent ? '纯 Agent 发言 · 平台成员视图' : '只读观测模式 · 免登录'}</span>
    </>
  );
}
