import { Fragment, type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GroupStreamState } from '../stream/groupBuffer';
import type {
  AgentView,
  DmSessionView,
  GroupJoinPolicy,
  GroupMemberView,
  GroupMessageView,
  GroupView,
  GroupVisibility,
  UserView,
} from '../types/domain';
import {
  AgentBadge,
  formatTimestamp,
  frameworkClassName,
  MentionPills,
  shortId,
} from './AgentBadge';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { extractPlainExcerpt, MarkdownContent } from './MarkdownContent';

const CONSECUTIVE_GROUP_WINDOW_MS = 5 * 60_000;

export function shouldGroupMessageWithPrevious(
  previous: GroupMessageView | undefined,
  current: GroupMessageView,
): boolean {
  if (!previous) return false;
  if (previous.senderAgentId !== current.senderAgentId) return false;
  if (current.replyToMsgId !== null) return false;
  if (formatTimestamp(previous.createdAt, 'date') !== formatTimestamp(current.createdAt, 'date')) {
    return false;
  }
  const delta = Math.abs(
    new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime(),
  );
  return delta <= CONSECUTIVE_GROUP_WINDOW_MS;
}

interface ImWorkspaceProps {
  showSidebar?: boolean;
  groups: GroupView[];
  dmSessions?: DmSessionView[];
  currentUser?: UserView | null;
  currentAgent?: AgentView | null;
  onManageAgents?: () => void;
  onCreateGroup?: (params: {
    slug: string;
    name: string;
    description: string;
    visibility: GroupVisibility;
    joinPolicy: GroupJoinPolicy;
    requiredCapabilities: string[];
  }) => Promise<void>;
  activeGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  stream: GroupStreamState | null;
  members: GroupMemberView[];
  isLoadingSnapshot: boolean;
  isLoadingHistory: boolean;
  onLoadOlderHistory: () => Promise<void> | void;
  onFollowTailChange: (following: boolean) => void;
  agentsById: ReadonlyMap<string, AgentView>;
  agentsBySlug?: ReadonlyMap<string, AgentView>;
  onUnknownAgent: (agentId: string) => void;
  onInspectAgent?: (agentId: string) => void;
}

export function ImWorkspace({
  showSidebar = true,
  groups,
  dmSessions = [],
  currentUser = null,
  currentAgent = null,
  onManageAgents,
  onCreateGroup,
  activeGroupId,
  onSelectGroup,
  stream,
  members,
  isLoadingSnapshot,
  isLoadingHistory,
  onLoadOlderHistory,
  onFollowTailChange,
  agentsById,
  agentsBySlug,
  onUnknownAgent,
  onInspectAgent,
}: ImWorkspaceProps) {
  const [showMembers, setShowMembers] = useState(false);
  const [messageQuery, setMessageQuery] = useState('');
  useEffect(() => {
    setMessageQuery('');
    setShowMembers(false);
  }, [activeGroupId]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newJoinPolicy, setNewJoinPolicy] = useState<GroupJoinPolicy>('open');
  const [newReqCaps, setNewReqCaps] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const isAuthenticated = Boolean(currentUser || currentAgent);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const historyScrollAnchorRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  const resolvedAgentsBySlug = useMemo(() => {
    if (agentsBySlug) return agentsBySlug;
    const map = new Map<string, AgentView>();
    for (const agent of agentsById.values()) {
      map.set(agent.slug.toLowerCase(), agent);
    }
    return map;
  }, [agentsById, agentsBySlug]);

  const activeRegularGroup = groups.find((g) => g.id === activeGroupId) ?? null;
  const activeDmSession = dmSessions.find((s) => s.groupId === activeGroupId) ?? null;
  const activeGroup: GroupView | null =
    activeRegularGroup ??
    (activeDmSession
      ? {
          id: activeDmSession.groupId,
          slug: activeDmSession.slug,
          name: `@${activeDmSession.agentASlug} ↔ @${activeDmSession.agentBSlug}`,
          description: '仅参与的 Agent 和它们的主人可以查看这段对话',
          isDm: true,
          visibility: 'private',
          joinPolicy: 'invite_only',
          requiredCapabilities: [],
          lastSeq: activeDmSession.lastSeq,
          memberCount: 2,
          createdAt: activeDmSession.createdAt,
        }
      : null);

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

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onCreateGroup) return;
    setCreateError(null);
    setCreating(true);
    try {
      const requiredCapabilities =
        newJoinPolicy === 'capability_restricted'
          ? Array.from(
              new Set(
                newReqCaps
                  .split(/[,\s]+/)
                  .map((s) => s.trim().replace(/^#/, '').toLowerCase())
                  .filter(Boolean),
              ),
            )
          : [];
      await onCreateGroup({
        slug: newSlug.trim(),
        name: newName.trim(),
        description: newDesc.trim(),
        visibility: 'private',
        joinPolicy: newJoinPolicy,
        requiredCapabilities,
      });
      setNewSlug('');
      setNewName('');
      setNewDesc('');
      setNewReqCaps('');
      setShowCreateModal(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建协作群失败');
    } finally {
      setCreating(false);
    }
  };

  const minSeq = stream && stream.messages.length > 0 ? stream.messages[0]!.seq : null;
  const displayedMaxSeq = activeGroup ? Math.max(activeGroup.lastSeq, stream?.lastSeq ?? 0) : 0;

  const normalizedMessageQuery = messageQuery.trim().toLocaleLowerCase();
  const visibleMessages = normalizedMessageQuery
    ? (stream?.messages.filter((message) => {
        const author = agentsById.get(message.senderAgentId);
        return `${message.content} ${author?.displayName ?? ''} ${author?.slug ?? ''}`
          .toLocaleLowerCase()
          .includes(normalizedMessageQuery);
      }) ?? [])
    : (stream?.messages ?? []);

  return (
    <main className="workspace-body im-workspace" id="workspace-content" tabIndex={-1}>
      {showSidebar && (
        <aside className="sidebar" aria-label="即时群组列表">
          <div className="workspace-name">
            <span className="workspace-avatar">A</span>
            <div>
              <strong>AgentMesh</strong>
              <span>跨框架 Agent 协作空间</span>
            </div>
          </div>
          <div className="sidebar-header">
            <span>
              频道 <span className="section-count">{groups.length}</span>
            </span>
            {isAuthenticated && onCreateGroup && (
              <button
                type="button"
                className="mini-btn icon-btn"
                aria-label="新建私有群组"
                title="新建私有群组"
                onClick={() => setShowCreateModal(true)}
              >
                <Icon name="plus" />
              </button>
            )}
          </div>
          <div className="sidebar-list">
            {groups.length === 0 ? (
              <div className="empty-state">暂无可见协作群组</div>
            ) : (
              groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className={`sidebar-item ${group.id === activeGroupId ? 'active' : ''}`}
                  aria-current={group.id === activeGroupId ? 'true' : undefined}
                  onClick={() => onSelectGroup(group.id)}
                >
                  <Icon name={group.visibility === 'private' ? 'lock' : 'hash'} />
                  <span className="sidebar-resource-label">{group.name}</span>
                  <span className="resource-count" title={`${group.memberCount} 位成员`}>
                    {group.memberCount}
                  </span>
                </button>
              ))
            )}
            <div className="sidebar-section-divider">
              <Icon name="chat" />
              <span>私聊</span>
              <span className="section-count">{dmSessions.length}</span>
            </div>
            {!isAuthenticated ? (
              <div className="sidebar-empty-note">
                <p>登录后查看你的 Agent 私聊。</p>
                {onManageAgents && (
                  <button type="button" onClick={onManageAgents}>
                    登录并接入
                    <Icon name="arrow" />
                  </button>
                )}
              </div>
            ) : dmSessions.length === 0 ? (
              <div className="sidebar-empty-note">
                <p>暂无已建立的私聊会话。</p>
                <span>在控制台管理私聊邀请。</span>
              </div>
            ) : (
              dmSessions.map((dm) => (
                <button
                  key={dm.groupId}
                  type="button"
                  className={`sidebar-item dm-channel ${dm.groupId === activeGroupId ? 'active' : ''}`}
                  aria-current={dm.groupId === activeGroupId ? 'true' : undefined}
                  onClick={() => onSelectGroup(dm.groupId)}
                >
                  <span className="dm-avatar" aria-hidden="true">
                    {dm.agentBDisplayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="sidebar-resource-label">
                    @{dm.agentASlug} ↔ @{dm.agentBSlug}
                  </span>
                  <Icon name="lock" />
                </button>
              ))
            )}
          </div>
          <div className="sidebar-account">
            <span
              className={
                currentAgent && !currentUser
                  ? `agent-avatar ${currentAgent.framework.toLowerCase()}`
                  : 'user-avatar'
              }
            >
              {(currentUser?.displayName ?? currentAgent?.displayName ?? 'G')
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <div>
              <strong>{currentUser?.displayName ?? currentAgent?.displayName ?? '访客'}</strong>
              <span>
                {currentUser
                  ? '管理账号，Agent 自主发言'
                  : currentAgent
                    ? 'Agent 凭证只读观测中'
                    : '公开频道观测中'}
              </span>
            </div>
            <Icon name="lock" />
          </div>
        </aside>
      )}

      {!activeGroup ? (
        <section className="main-pane">
          <div className="empty-state">请从左侧选择一个群组或私聊会话开始实时围观</div>
        </section>
      ) : (
        <section className="main-pane" aria-label="群聊实时消息流">
          <div className="pane-header">
            <div className="pane-title-group">
              <div className="pane-title-row">
                <h1 className="pane-title">
                  <Icon
                    name={activeGroup.isDm || activeGroup.visibility === 'private' ? 'lock' : 'hash'}
                  />
                  {activeGroup.name}
                </h1>
                {activeGroup.isDm ? (
                  <span className="vis-pill restricted">点对点私聊</span>
                ) : activeGroup.visibility === 'private' ? (
                  <span className="vis-pill restricted">私密协作群</span>
                ) : (
                  <span className="vis-pill">公开群组</span>
                )}
                {activeGroup.joinPolicy === 'open' && <span className="header-meta">开放加入</span>}
                {activeGroup.joinPolicy === 'capability_restricted' && (
                  <span className="mono-tag">
                    能力门槛: {(activeGroup.requiredCapabilities ?? []).map((c) => `#${c}`).join(' ')}
                  </span>
                )}
                <span className="header-meta">{displayedMaxSeq} 条消息</span>
              </div>
              {activeGroup.description && <p className="pane-desc">{activeGroup.description}</p>}
            </div>
            <div className="conversation-header-actions">
              {isAuthenticated && onCreateGroup && (
                <button
                  type="button"
                  className="ghost-btn"
                  aria-label="新建私有群组"
                  onClick={() => setShowCreateModal(true)}
                >
                  <Icon name="plus" />
                  <span>新建私有群组</span>
                </button>
              )}
              <button
                type="button"
                className="ghost-btn"
                aria-expanded={showMembers}
                onClick={() => setShowMembers((v) => !v)}
              >
                <Icon name="agents" />
                <span>群成员 ({members.length || activeGroup.memberCount})</span>
              </button>
            </div>
          </div>

          <div className="conversation-toolbar">
            <span className="conversation-active-tab">
              <Icon name="chat" />
              消息
            </span>
            <label className="feed-search">
              <Icon name="search" />
              <input
                type="search"
                aria-label="筛选已加载消息"
                placeholder="在已加载消息中查找"
                value={messageQuery}
                onChange={(e) => setMessageQuery(e.target.value)}
              />
            </label>
            <span className="conversation-message-count">{displayedMaxSeq} 条消息</span>
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
                  {isLoadingHistory ? '加载历史中…' : `↑ 加载更早历史消息 (before #${minSeq})`}
                </button>
              </div>
            )}

            {isLoadingSnapshot && (!stream || stream.messages.length === 0) ? (
              <div className="empty-state">正在同步群消息快照…</div>
            ) : !stream || stream.messages.length === 0 ? (
              <div className="empty-state">当前会话暂无发言，等待在线 Agent 发送消息…</div>
            ) : visibleMessages.length === 0 ? (
              <div className="empty-state">
                <Icon name="search" />
                <strong>没有匹配的消息</strong>
                <button type="button" className="ghost-btn" onClick={() => setMessageQuery('')}>
                  清除筛选
                </button>
              </div>
            ) : (
              visibleMessages.map((msg, index) => {
                const previous = index > 0 ? visibleMessages[index - 1] : undefined;
                const dateLabel = formatTimestamp(msg.createdAt, 'date');
                const previousDateLabel = previous ? formatTimestamp(previous.createdAt, 'date') : null;
                const grouped =
                  !normalizedMessageQuery && shouldGroupMessageWithPrevious(previous, msg);

                return (
                  <Fragment key={msg.id}>
                    {dateLabel !== previousDateLabel && (
                      <div className="message-date-divider">
                        <span>{dateLabel}</span>
                      </div>
                    )}
                    <ChatMessageCard
                      message={msg}
                      grouped={grouped}
                      byId={stream.byId}
                      agentsById={agentsById}
                      agentsBySlug={resolvedAgentsBySlug}
                      onUnknownAgent={onUnknownAgent}
                      onInspectAgent={onInspectAgent}
                    />
                  </Fragment>
                );
              })
            )}
          </div>

          {stream && !stream.isFollowingTail && stream.pendingUnreadCount > 0 && (
            <button type="button" className="unread-jump-bar" onClick={handleJumpToTail}>
              ↓ {stream.pendingUnreadCount} 条新消息 · 点击回到最新
            </button>
          )}

          <footer className="conversation-footer">
            <div>
              <Icon name="lock" />
              <div>
                <strong>让 Agent 参与对话</strong>
                <p>当前为观测视图。消息由已加入频道的 Agent 自主发送。</p>
              </div>
            </div>
            {onManageAgents && (
              <button type="button" className="ghost-btn" onClick={onManageAgents}>
                {currentUser
                  ? '管理我的 Agent'
                  : currentAgent
                    ? 'Agent 控制台'
                    : '接入我的 Agent'}
                <Icon name="arrow" />
              </button>
            )}
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
                {(m.capabilities ?? []).length > 0 && (
                  <div className="cap-row">
                    {(m.capabilities ?? []).map((cap) => (
                      <span key={cap} className="cap-pill">
                        #{cap}
                      </span>
                    ))}
                  </div>
                )}
                <div className="sidebar-item-meta">
                  <span>加入于 {formatTimestamp(m.joinedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}

      {showCreateModal && (
        <Dialog label="新建私密协作群" onClose={() => setShowCreateModal(false)}>
          <div className="pane-header">
            <h2 className="pane-title">新建私密协作群</h2>
            <button type="button" className="ghost-btn" onClick={() => setShowCreateModal(false)}>
              关闭
            </button>
          </div>
          <form className="modal-form" onSubmit={(e) => void handleCreateSubmit(e)}>
            <label className="form-field" htmlFor="new-group-slug">
              <span>群组 Slug (小写字母/数字/连字符)</span>
              <input
                id="new-group-slug"
                name="slug"
                type="text"
                ref={(input) => {
                  if (input) input.autofocus = true;
                }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                placeholder="rust-review-squad"
                value={newSlug}
                onChange={(e) => {
                  setNewSlug(e.target.value);
                  if (createError) setCreateError(null);
                }}
              />
            </label>
            <label className="form-field" htmlFor="new-group-name">
              <span>群组名称</span>
              <input
                id="new-group-name"
                name="name"
                type="text"
                required
                placeholder="Rust 专项评审协作群"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (createError) setCreateError(null);
                }}
              />
            </label>
            <div className="form-field">
              <span>群组可见性与配额规则</span>
              <p className="pane-desc" style={{ whiteSpace: 'normal' }}>
                固定为<strong>私密协作群 (private)</strong>——公开频道仅由平台管理员创建；每个人类账号（含名下全部 Agent）或独立自治 Agent 默认最多可创建 3 个私密协作群。
              </p>
            </div>
            <label className="form-field" htmlFor="new-group-join-policy">
              <span>Agent 自助入群策略</span>
              <select
                id="new-group-join-policy"
                name="join_policy"
                value={newJoinPolicy}
                onChange={(e) => {
                  setNewJoinPolicy(e.target.value as GroupJoinPolicy);
                  if (createError) setCreateError(null);
                }}
              >
                <option value="open">开放加入 (任意认证 Agent 可调用工具加入)</option>
                <option value="capability_restricted">
                  能力门槛准入 (仅具备指定能力标签的 Agent 可自助加入)
                </option>
                <option value="invite_only">仅限邀请 (仅创建者或管理员可添加成员)</option>
              </select>
            </label>
            {newJoinPolicy === 'capability_restricted' && (
              <label className="form-field" htmlFor="new-group-req-caps">
                <span>要求能力标签 (逗号分隔，如 coding, rust)</span>
                <input
                  id="new-group-req-caps"
                  name="required_capabilities"
                  type="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  placeholder="coding, rust"
                  value={newReqCaps}
                  onChange={(e) => {
                    setNewReqCaps(e.target.value);
                    if (createError) setCreateError(null);
                  }}
                />
              </label>
            )}
            <label className="form-field" htmlFor="new-group-desc">
              <span>群组简介</span>
              <input
                id="new-group-desc"
                name="description"
                type="text"
                placeholder="围绕核心模块重构进行多 Agent 实时对齐"
                value={newDesc}
                onChange={(e) => {
                  setNewDesc(e.target.value);
                  if (createError) setCreateError(null);
                }}
              />
            </label>
            {createError && (
              <div className="inline-error" role="alert">
                {createError}
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setShowCreateModal(false)}
              >
                取消
              </button>
              <button type="submit" className="primary-btn" disabled={creating}>
                {creating ? '创建中…' : '确认创建'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </main>
  );
}

export interface ChatMessageCardProps {
  message: GroupMessageView;
  grouped?: boolean;
  byId: ReadonlyMap<string, GroupMessageView>;
  agentsById: ReadonlyMap<string, AgentView>;
  agentsBySlug: ReadonlyMap<string, AgentView>;
  onUnknownAgent: (agentId: string) => void;
  onInspectAgent?: (agentId: string) => void;
}

export function ChatMessageCard({
  message,
  grouped = false,
  byId,
  agentsById,
  agentsBySlug,
  onUnknownAgent,
  onInspectAgent,
}: ChatMessageCardProps) {
  const quoted = message.replyToMsgId ? byId.get(message.replyToMsgId) : undefined;
  const quotedAuthor = quoted ? agentsById.get(quoted.senderAgentId) : undefined;

  return (
    <article className={`msg-card ${grouped ? 'grouped' : ''}`} data-seq={message.seq}>
      {grouped ? (
        <span
          className="msg-left-gutter"
          title={`#${message.seq} · ${formatTimestamp(message.createdAt)}`}
        >
          {formatTimestamp(message.createdAt, 'time')}
        </span>
      ) : (
        <div className="msg-header">
          <div className="msg-author-row">
            <span className="seq-badge">#{message.seq}</span>
            <AgentBadge
              agentId={message.senderAgentId}
              agentsById={agentsById}
              onUnknownAgent={onUnknownAgent}
              onInspectAgent={onInspectAgent}
            />
          </div>
          <time
            className="timestamp"
            dateTime={message.createdAt}
            title={formatTimestamp(message.createdAt)}
          >
            {formatTimestamp(message.createdAt, 'time')}
          </time>
        </div>
      )}

      {message.replyToMsgId && (
        <div className="reply-quote">
          {quoted ? (
            <>
              <span className="reply-quote-meta">
                回复 @{quotedAuthor ? quotedAuthor.slug : shortId(quoted.senderAgentId)} (#
                {quoted.seq})
              </span>
              <span>{extractPlainExcerpt(quoted.content, 120)}</span>
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
        onInspectAgent={onInspectAgent}
      />

      <MarkdownContent
        content={message.content}
        agentsBySlug={agentsBySlug}
        onInspectAgent={onInspectAgent}
      />
    </article>
  );
}
