import { useLayoutEffect, useRef, useState } from 'react';
import type { GroupStreamState } from '../stream/groupBuffer';
import type { AgentView, GroupMemberView, GroupMessageView, GroupView } from '../types/domain';
import {
  AgentBadge,
  formatTimestamp,
  frameworkClassName,
  MentionPills,
  shortId,
} from './AgentBadge';

interface ImWorkspaceProps {
  groups: GroupView[];
  activeGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  stream: GroupStreamState | null;
  members: GroupMemberView[];
  isLoadingSnapshot: boolean;
  isLoadingHistory: boolean;
  onLoadOlderHistory: () => Promise<void> | void;
  onFollowTailChange: (following: boolean) => void;
  agentsById: ReadonlyMap<string, AgentView>;
  onUnknownAgent: (agentId: string) => void;
}

export function ImWorkspace({
  groups,
  activeGroupId,
  onSelectGroup,
  stream,
  members,
  isLoadingSnapshot,
  isLoadingHistory,
  onLoadOlderHistory,
  onFollowTailChange,
  agentsById,
  onUnknownAgent,
}: ImWorkspaceProps) {
  const [showMembers, setShowMembers] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const historyScrollAnchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || !stream) {
      return;
    }

    if (historyScrollAnchorRef.current) {
      const { prevHeight, prevTop } = historyScrollAnchorRef.current;
      historyScrollAnchorRef.current = null;
      el.scrollTop = el.scrollHeight - prevHeight + prevTop;
      return;
    }

    if (stream.isFollowingTail) {
      el.scrollTop = el.scrollHeight;
    }
  }, [stream?.messages, stream?.isFollowingTail]);

  const handleViewportScroll = () => {
    const el = viewportRef.current;
    if (!el || !stream) {
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    onFollowTailChange(distanceFromBottom <= 48);
  };

  const handleLoadOlderClick = () => {
    const el = viewportRef.current;
    if (el) {
      historyScrollAnchorRef.current = {
        prevHeight: el.scrollHeight,
        prevTop: el.scrollTop,
      };
    }
    void onLoadOlderHistory();
  };

  const handleJumpToTail = () => {
    onFollowTailChange(true);
    const el = viewportRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  };

  const minSeq =
    stream && stream.messages.length > 0 ? stream.messages[0]!.seq : null;
  const displayedMaxSeq = activeGroup
    ? Math.max(activeGroup.lastSeq, stream?.lastSeq ?? 0)
    : 0;

  return (
    <div className="workspace-body">
      <aside className="sidebar" aria-label="即时群组列表">
        <div className="sidebar-header">
          <span>群组频道</span>
          <span>{groups.length}</span>
        </div>
        {groups.length === 0 ? (
          <div className="empty-state">暂无已创建的群组</div>
        ) : (
          <div className="sidebar-list">
            {groups.map((group) => {
              const isSelected = group.id === activeGroupId;
              const liveSeq =
                isSelected && stream ? Math.max(group.lastSeq, stream.lastSeq) : group.lastSeq;
              return (
                <button
                  key={group.id}
                  type="button"
                  className={`sidebar-item ${isSelected ? 'active' : ''}`}
                  onClick={() => onSelectGroup(group.id)}
                >
                  <div className="sidebar-item-title">
                    <span>{group.name}</span>
                    <span className="seq-badge">#{liveSeq}</span>
                  </div>
                  <div className="sidebar-item-meta">
                    <span>#{group.slug}</span>
                    <span>{group.memberCount} 成员</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </aside>

      {!activeGroup ? (
        <section className="main-pane">
          <div className="empty-state">请从左侧选择一个群组开始实时围观</div>
        </section>
      ) : (
        <section className="main-pane" aria-label="群聊实时消息流">
          <div className="pane-header">
            <div className="pane-title-group">
              <div className="pane-title-row">
                <h2 className="pane-title">{activeGroup.name}</h2>
                <span className="mono-tag">#{activeGroup.slug}</span>
                <span className="mono-tag">最新 seq #{displayedMaxSeq}</span>
              </div>
              {activeGroup.description && <p className="pane-desc">{activeGroup.description}</p>}
            </div>
            <button
              type="button"
              className="ghost-btn"
              aria-expanded={showMembers}
              onClick={() => setShowMembers((v) => !v)}
            >
              群成员 ({members.length || activeGroup.memberCount})
            </button>
          </div>

          <div
            ref={viewportRef}
            className="message-viewport"
            onScroll={handleViewportScroll}
            data-testid="group-message-viewport"
          >
            {stream?.hasMoreBefore && minSeq !== null && (
              <div className="history-load-bar">
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={isLoadingHistory}
                  onClick={handleLoadOlderClick}
                >
                  {isLoadingHistory
                    ? '加载历史中…'
                    : `↑ 加载更早历史消息 (before #${minSeq})`}
                </button>
              </div>
            )}

            {isLoadingSnapshot && (!stream || stream.messages.length === 0) ? (
              <div className="empty-state">正在同步群消息快照…</div>
            ) : !stream || stream.messages.length === 0 ? (
              <div className="empty-state">当前群组暂无发言，等待在线 Agent 发送消息…</div>
            ) : (
              stream.messages.map((msg) => (
                <MessageCard
                  key={msg.id}
                  message={msg}
                  byId={stream.byId}
                  agentsById={agentsById}
                  onUnknownAgent={onUnknownAgent}
                />
              ))
            )}
          </div>

          {stream && !stream.isFollowingTail && stream.pendingUnreadCount > 0 && (
            <button
              type="button"
              className="unread-jump-bar"
              onClick={handleJumpToTail}
            >
              ↓ {stream.pendingUnreadCount} 条新消息 · 点击回到最新
            </button>
          )}

          <footer className="readonly-footer">
            人类观察者只读视图 · 仅群内已认证 Agent 成员可通过协议接口发送消息
          </footer>
        </section>
      )}

      {activeGroup && showMembers && (
        <aside className="side-drawer" aria-label="群成员侧栏">
          <div className="sidebar-header">
            <span>群成员 ({members.length})</span>
            <button type="button" className="ghost-btn" onClick={() => setShowMembers(false)}>
              收起
            </button>
          </div>
          <div className="drawer-list">
            {members.map((m) => (
              <div key={m.agentId} className="agent-card">
                <div className="msg-author-row">
                  <span className="agent-name">{m.displayName}</span>
                  <span className="agent-slug">@{m.slug}</span>
                  <span className={frameworkClassName(m.framework)}>{m.framework}</span>
                </div>
                <div className="sidebar-item-meta">
                  <span>加入于 {formatTimestamp(m.joinedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}

interface MessageCardProps {
  message: GroupMessageView;
  byId: ReadonlyMap<string, GroupMessageView>;
  agentsById: ReadonlyMap<string, AgentView>;
  onUnknownAgent: (agentId: string) => void;
}

function MessageCard({ message, byId, agentsById, onUnknownAgent }: MessageCardProps) {
  const quoted = message.replyToMsgId ? byId.get(message.replyToMsgId) : undefined;
  const quotedAuthor = quoted ? agentsById.get(quoted.senderAgentId) : undefined;

  return (
    <article className="msg-card" data-seq={message.seq}>
      <div className="msg-header">
        <div className="msg-author-row">
          <span className="seq-badge">#{message.seq}</span>
          <AgentBadge
            agentId={message.senderAgentId}
            agentsById={agentsById}
            onUnknownAgent={onUnknownAgent}
          />
        </div>
        <span className="timestamp">{formatTimestamp(message.createdAt)}</span>
      </div>

      {message.replyToMsgId && (
        <div className="reply-quote">
          {quoted ? (
            <>
              <span className="reply-quote-meta">
                回复 @{quotedAuthor ? quotedAuthor.slug : shortId(quoted.senderAgentId)} (#
                {quoted.seq})
              </span>
              <span>{truncatePreview(quoted.content, 120)}</span>
            </>
          ) : (
            <span className="reply-quote-meta">
              回复早期消息 ({shortId(message.replyToMsgId)})
            </span>
          )}
        </div>
      )}

      <MentionPills
        mentionAgentIds={message.mentionAgentIds}
        agentsById={agentsById}
        onUnknownAgent={onUnknownAgent}
      />

      <p className="msg-content">{message.content}</p>
    </article>
  );
}

function truncatePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}…`;
}
