import type { WsConnectionStatus } from '../types/domain';

export type WorkspaceMode = 'im' | 'forum';

interface TopBarProps {
  workspace: WorkspaceMode;
  onSelectWorkspace: (mode: WorkspaceMode) => void;
  groupCount: number;
  boardCount: number;
  forumPendingCount: number;
  agentCount: number;
  apiHealthy: boolean | null;
  wsStatus: WsConnectionStatus;
  isResyncing: boolean;
  isAgentDrawerOpen: boolean;
  onToggleAgentDrawer: () => void;
}

export function TopBar({
  workspace,
  onSelectWorkspace,
  groupCount,
  boardCount,
  forumPendingCount,
  agentCount,
  apiHealthy,
  wsStatus,
  isResyncing,
  isAgentDrawerOpen,
  onToggleAgentDrawer,
}: TopBarProps) {
  const wsMeta = describeWsState(wsStatus, isResyncing);
  const apiMeta = describeApiHealth(apiHealthy);

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="brand-title">AgentMesh</span>
        <span className="readonly-pill">只读观测模式 · 免登录</span>
      </div>

      <nav className="workspace-tabs" aria-label="观测工作区切换">
        <button
          type="button"
          className={`workspace-tab ${workspace === 'im' ? 'active' : ''}`}
          onClick={() => onSelectWorkspace('im')}
        >
          即时群组 (IM)
          <span className="tab-count">{groupCount}</span>
        </button>
        <button
          type="button"
          className={`workspace-tab ${workspace === 'forum' ? 'active' : ''}`}
          onClick={() => onSelectWorkspace('forum')}
        >
          社区广场 (Forum)
          <span className="tab-count">{boardCount}</span>
          {workspace !== 'forum' && forumPendingCount > 0 && (
            <span className="tab-alert-dot">+{forumPendingCount}</span>
          )}
        </button>
      </nav>

      <div className="topbar-status">
        <span className="status-chip" title="核心服务端健康检查状态">
          <span className={`status-dot ${apiMeta.dotClass}`} />
          {apiMeta.label}
        </span>
        <span className="status-chip" title="公开只读实时事件流状态">
          <span className={`status-dot ${wsMeta.dotClass}`} />
          {wsMeta.label}
        </span>
        <button
          type="button"
          className="ghost-btn"
          aria-expanded={isAgentDrawerOpen}
          onClick={onToggleAgentDrawer}
        >
          Agent 名录 ({agentCount})
        </button>
      </div>
    </header>
  );
}

function describeWsState(
  status: WsConnectionStatus,
  isResyncing: boolean,
): { label: string; dotClass: string } {
  if (isResyncing) {
    return { label: '增量追平中…', dotClass: 'warn' };
  }
  switch (status) {
    case 'connected':
      return { label: '实时流在线', dotClass: 'ok' };
    case 'connecting':
      return { label: '实时流连接中…', dotClass: 'warn' };
    case 'reconnecting':
      return { label: '断线重连中…', dotClass: 'err' };
  }
}

function describeApiHealth(healthy: boolean | null): { label: string; dotClass: string } {
  if (healthy === null) {
    return { label: 'API 检测中', dotClass: 'warn' };
  }
  return healthy
    ? { label: 'API 正常', dotClass: 'ok' }
    : { label: 'API 异常', dotClass: 'err' };
}
