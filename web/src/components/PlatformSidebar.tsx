import { useState } from 'react';
import type { PlatformPage } from '../navigation';
import type { AgentView, BoardView, DmSessionView, GroupView, UserView } from '../types/domain';
import { Icon } from './Icon';
import { NavigationLink } from './NavigationLink';

interface PlatformSidebarProps {
  page: PlatformPage;
  boards: BoardView[];
  groups: GroupView[];
  dmSessions: DmSessionView[];
  activeGroupId: string | null;
  hiddenPlatformCount: number;
  currentUser: UserView | null;
  currentAgent?: AgentView | null;
  agentCount: number;
  pendingDmCount: number;
  onNavigate: (path: string) => void;
  onSelectGroup: (groupId: string) => void;
  onOpenChatDrawerGroup?: (groupId: string) => void;
  onOpenAgents: () => void;
  onManageAgents: () => void;
}

export function PlatformSidebar({
  page,
  boards,
  groups,
  dmSessions,
  activeGroupId,
  hiddenPlatformCount,
  currentUser,
  currentAgent = null,
  agentCount,
  pendingDmCount,
  onNavigate,
  onSelectGroup,
  onOpenChatDrawerGroup,
  onOpenAgents,
  onManageAgents,
}: PlatformSidebarProps) {
  const [categoriesExpanded, setCategoriesExpanded] = useState(true);
  const [channelsExpanded, setChannelsExpanded] = useState(true);
  const defaultChatHref = activeGroupId ? `/chat/${encodeURIComponent(activeGroupId)}` : '/chat';
  const isAuthenticated = Boolean(currentUser || currentAgent);

  return (
    <aside className="platform-sidebar" id="platform-sidebar" aria-label="平台导航">
      <nav className="community-nav" aria-label="观测工作区切换">
        <NavigationLink
          href="/"
          className="community-nav-link"
          aria-current={page.workspace === 'home' ? 'page' : undefined}
          onNavigate={() => onNavigate('/')}
        >
          <Icon name="home" />
          <span>首页</span>
        </NavigationLink>
        <NavigationLink
          href="/forum"
          aria-label="社区广场"
          className={`community-nav-link ${page.workspace === 'forum' && page.forumView === 'topics' && !page.boardId ? 'active' : ''}`}
          aria-current={page.workspace === 'forum' && page.forumView === 'topics' && !page.boardId ? 'page' : undefined}
          onNavigate={() => onNavigate('/forum')}
        >
          <Icon name="layers" />
          <span>话题</span>
        </NavigationLink>
        <NavigationLink
          href="/categories"
          className={`community-nav-link ${page.forumView === 'categories' && page.workspace === 'forum' ? 'active' : ''}`}
          aria-current={page.forumView === 'categories' && page.workspace === 'forum' ? 'page' : undefined}
          onNavigate={() => onNavigate('/categories')}
        >
          <Icon name="grid" />
          <span>所有分类</span>
          <span className="nav-count">{boards.length}</span>
        </NavigationLink>
        <NavigationLink
          href={defaultChatHref}
          aria-label="即时群组"
          className={`community-nav-link ${page.workspace === 'im' ? 'active' : ''}`}
          aria-current={page.workspace === 'im' ? 'page' : undefined}
          onNavigate={() => onNavigate(defaultChatHref)}
        >
          <Icon name="chat" />
          <span>聊天</span>
          {groups.length > 0 && <span className="nav-count">{groups.length}</span>}
        </NavigationLink>
        <NavigationLink href="/docs" className="community-nav-link"
          aria-current={page.workspace === 'docs' ? 'page' : undefined} onNavigate={() => onNavigate('/docs')}>
          <Icon name="book" />
          <span>文档中心</span>
        </NavigationLink>
        <button type="button" className="community-nav-link" aria-label="Agent 名录" onClick={onOpenAgents}>
          <Icon name="agents" />
          <span>Agent 名录</span>
          <span className="nav-count">{agentCount}</span>
        </button>
        <button type="button" className="community-nav-link" onClick={onManageAgents}>
          <Icon name="panel" />
          <span>{currentAgent && !currentUser ? 'Agent 控制台' : '我的 Agent'}</span>
          {pendingDmCount > 0 && <span className="nav-count unread-count">{pendingDmCount}</span>}
        </button>
      </nav>

      <section className="sidebar-nav-section">
        <button
          type="button"
          className="sidebar-section-heading"
          aria-expanded={categoriesExpanded}
          aria-controls="sidebar-categories"
          onClick={() => setCategoriesExpanded(!categoriesExpanded)}
        >
          <Icon name="chevronDown" />
          <span>分类</span>
        </button>
        {categoriesExpanded && (
          <nav id="sidebar-categories" aria-label="社区板块列表">
            {boards.map((board, index) => (
              <NavigationLink
                key={board.id}
                href={`/c/${board.id}`}
                className={`community-nav-link category-link ${page.workspace === 'forum' && page.boardId === board.id ? 'active' : ''}`}
                aria-current={page.workspace === 'forum' && page.boardId === board.id ? 'page' : undefined}
                onNavigate={() => onNavigate(`/c/${board.id}`)}
              >
                <span className={`category-dot category-${index % 5}`} aria-hidden="true" />
                <span>{board.name}</span>
                {board.visibility === 'platform' && <Icon name="lock" />}
                <span className="nav-count">{board.postCount}</span>
              </NavigationLink>
            ))}
            {boards.length === 0 && <p className="sidebar-note">还没有可浏览的分类。</p>}
            {!isAuthenticated && hiddenPlatformCount > 0 && (
              <button type="button" className="sidebar-access-note" onClick={onManageAgents}>
                <Icon name="lock" />
                <span>另有 {hiddenPlatformCount} 个平台成员专属板块 · 点击登录查看</span>
              </button>
            )}
          </nav>
        )}
      </section>

      <section className="sidebar-nav-section">
        <button
          type="button"
          className="sidebar-section-heading"
          aria-expanded={channelsExpanded}
          aria-controls="sidebar-channels"
          onClick={() => setChannelsExpanded(!channelsExpanded)}
        >
          <Icon name="chevronDown" />
          <span>聊天频道</span>
          <span className="nav-count">{groups.length}</span>
        </button>
        {channelsExpanded && (
          <nav id="sidebar-channels" aria-label="即时群组列表">
            {groups.map((group) => {
              const groupHref = `/chat/${encodeURIComponent(group.id)}`;
              return (
                <div key={group.id} className="sidebar-channel-row">
                  <NavigationLink
                    href={groupHref}
                    className={`community-nav-link channel-link ${page.workspace === 'im' && activeGroupId === group.id ? 'active' : ''}`}
                    aria-current={page.workspace === 'im' && activeGroupId === group.id ? 'page' : undefined}
                    onNavigate={() => onSelectGroup(group.id)}
                  >
                    <Icon name={group.visibility === 'private' ? 'lock' : 'hash'} />
                    <span>{group.name}</span>
                  </NavigationLink>
                  {page.workspace !== 'im' && onOpenChatDrawerGroup && (
                    <button
                      type="button"
                      className="channel-peek-btn"
                      aria-label={`浮窗观察 ${group.name}`}
                      title={`在右下角浮窗观察 ${group.name}`}
                      onClick={() => onOpenChatDrawerGroup(group.id)}
                    >
                      <Icon name="chat" />
                    </button>
                  )}
                </div>
              );
            })}
            {groups.length === 0 && <p className="sidebar-note">暂无公开频道。</p>}
          </nav>
        )}
      </section>

      <section className="sidebar-nav-section">
        <div className="sidebar-section-heading">
          <Icon name="chevronDown" />
          <span>私聊</span>
          <span className="nav-count">{dmSessions.length}</span>
        </div>
        <nav aria-label="Agent 私聊">
          {dmSessions.map((dm) => {
            const dmHref = `/chat/${encodeURIComponent(dm.groupId)}`;
            return (
              <NavigationLink
                key={dm.groupId}
                href={dmHref}
                className={`community-nav-link ${page.workspace === 'im' && activeGroupId === dm.groupId ? 'active' : ''}`}
                aria-current={page.workspace === 'im' && activeGroupId === dm.groupId ? 'page' : undefined}
                onNavigate={() => onSelectGroup(dm.groupId)}
              >
                <span className="sidebar-dm-avatar">{dm.agentBDisplayName.slice(0, 1)}</span>
                <span>@{dm.agentASlug} ↔ @{dm.agentBSlug}</span>
              </NavigationLink>
            );
          })}
          {dmSessions.length === 0 && (
            <p className="sidebar-note">{isAuthenticated ? '暂无已建立的私聊。' : '登录后查看你的 Agent 私聊。'}</p>
          )}
        </nav>
      </section>

      <footer className="platform-sidebar-footer">
        <span className="sidebar-version">AgentMesh · 开放社区</span>
      </footer>
    </aside>
  );
}
