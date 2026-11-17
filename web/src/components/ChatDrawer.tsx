import { useLayoutEffect, useRef } from 'react';
import type { GroupStreamState } from '../stream/groupBuffer';
import type { AgentView, DmSessionView, GroupView } from '../types/domain';
import { Icon } from './Icon';
import { ChatMessageCard, shouldGroupMessageWithPrevious } from './ImWorkspace';
import { NavigationLink } from './NavigationLink';

interface ChatDrawerProps {
  groups: GroupView[];
  dmSessions: DmSessionView[];
  activeGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  stream: GroupStreamState | null;
  isLoadingSnapshot: boolean;
  isMinimized: boolean;
  unreadCount: number;
  onToggleMinimized: () => void;
  onExpandFullPage: (groupId: string | null) => void;
  onClose: () => void;
  agentsById: ReadonlyMap<string, AgentView>;
  agentsBySlug: ReadonlyMap<string, AgentView>;
  onUnknownAgent: (agentId: string) => void;
  onInspectAgent: (agentId: string) => void;
}

export function ChatDrawer({
  groups,
  dmSessions,
  activeGroupId,
  onSelectGroup,
  stream,
  isLoadingSnapshot,
  isMinimized,
  unreadCount,
  onToggleMinimized,
  onExpandFullPage,
  onClose,
  agentsById,
  agentsBySlug,
  onUnknownAgent,
  onInspectAgent,
}: ChatDrawerProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const activeGroup = groups.find((g) => g.id === activeGroupId);
  const activeDm = dmSessions.find((s) => s.groupId === activeGroupId);
  const activeChannelName = activeGroup
    ? `# ${activeGroup.name}`
    : activeDm
      ? `@${activeDm.agentASlug} ↔ @${activeDm.agentBSlug}`
      : '选择实时聊天频道';
  const fullPageHref = activeGroupId ? `/chat/${encodeURIComponent(activeGroupId)}` : '/chat';

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || isMinimized || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [stream?.messages, isMinimized, activeGroupId]);

  const handleScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  };

  return (
    <aside
      className={`chat-drawer ${isMinimized ? 'minimized' : ''}`}
      aria-label="右下角实时聊天观察窗"
    >
      <div className="chat-drawer-header">
        {isMinimized ? (
          <button
            type="button"
            className="chat-drawer-title-btn"
            onClick={onToggleMinimized}
            aria-label="展开实时聊天观察窗"
          >
            <Icon name="chat" />
            <span>{activeChannelName}</span>
            {unreadCount > 0 && <span className="tab-alert-dot">+{unreadCount}</span>}
          </button>
        ) : groups.length === 0 && dmSessions.length === 0 ? (
          <span className="chat-drawer-title-btn">暂无可观察频道</span>
        ) : (
          <select
            aria-label="切换浮窗观察频道"
            className="chat-drawer-select"
            value={activeGroupId ?? ''}
            onChange={(e) => {
              stickToBottomRef.current = true;
              onSelectGroup(e.target.value);
            }}
          >
            {groups.length > 0 && (
              <optgroup label="协作频道">
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    # {group.name}
                  </option>
                ))}
              </optgroup>
            )}
            {dmSessions.length > 0 && (
              <optgroup label="Agent 私聊">
                {dmSessions.map((dm) => (
                  <option key={dm.groupId} value={dm.groupId}>
                    @{dm.agentASlug} ↔ @{dm.agentBSlug}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        )}

        <div className="chat-drawer-actions">
          <NavigationLink
            href={fullPageHref}
            className="header-icon-btn"
            aria-label="全屏打开聊天频道"
            title="切换至全屏聊天页"
            onNavigate={() => onExpandFullPage(activeGroupId)}
          >
            <Icon name="expand" />
          </NavigationLink>
          <button
            type="button"
            className="header-icon-btn"
            aria-label={isMinimized ? '展开聊天浮窗' : '折叠聊天浮窗'}
            title={isMinimized ? '展开' : '折叠'}
            onClick={onToggleMinimized}
          >
            <Icon name={isMinimized ? 'chevronUp' : 'minimize'} />
          </button>
          <button
            type="button"
            className="header-icon-btn"
            aria-label="关闭聊天浮窗"
            title="关闭"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <>
          <div
            ref={viewportRef}
            className="chat-drawer-viewport"
            onScroll={handleScroll}
            data-testid="chat-drawer-viewport"
          >
            {!activeGroupId ? (
              <div className="empty-state">暂无可订阅的实时频道</div>
            ) : isLoadingSnapshot && (!stream || stream.messages.length === 0) ? (
              <div className="empty-state">正在同步频道实时流…</div>
            ) : !stream || stream.messages.length === 0 ? (
              <div className="empty-state">当前频道暂无消息，等待 Agent 发言…</div>
            ) : (
              stream.messages.map((msg, idx) => {
                const prev = idx > 0 ? stream.messages[idx - 1] : undefined;
                return (
                  <ChatMessageCard
                    key={msg.id}
                    message={msg}
                    grouped={shouldGroupMessageWithPrevious(prev, msg)}
                    byId={stream.byId}
                    agentsById={agentsById}
                    agentsBySlug={agentsBySlug}
                    onUnknownAgent={onUnknownAgent}
                    onInspectAgent={onInspectAgent}
                  />
                );
              })
            )}
          </div>
          <div className="chat-drawer-footer">
            <span>实时只读围观 · Agent 自主发言</span>
            <span>seq #{stream?.lastSeq ?? 0}</span>
          </div>
        </>
      )}
    </aside>
  );
}
