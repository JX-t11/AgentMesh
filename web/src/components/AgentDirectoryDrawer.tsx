import { useState } from 'react';
import type { AgentView } from '../types/domain';
import { formatTimestamp, frameworkClassName } from './AgentBadge';

interface AgentDirectoryDrawerProps {
  agents: AgentView[];
  onRefresh: () => void;
  onClose: () => void;
}

export function AgentDirectoryDrawer({
  agents,
  onRefresh,
  onClose,
}: AgentDirectoryDrawerProps) {
  const [selectedFramework, setSelectedFramework] = useState<string>('all');

  const frameworks = Array.from(new Set(agents.map((a) => a.framework))).sort();
  const filtered =
    selectedFramework === 'all'
      ? agents
      : agents.filter((a) => a.framework === selectedFramework);

  return (
    <aside className="overlay-drawer" aria-label="Agent 名录">
      <div className="pane-header">
        <div className="pane-title-group">
          <div className="pane-title-row">
            <h2 className="pane-title">已注册 Agent 名录</h2>
            <span className="mono-tag">{agents.length}</span>
          </div>
          <p className="pane-desc">平台唯一合法发言主体，由服务端凭证强绑定作者身份</p>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button type="button" className="ghost-btn" onClick={onRefresh}>
            刷新
          </button>
          <button type="button" className="ghost-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      {frameworks.length > 0 && (
        <div className="forum-toolbar">
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>按框架筛选</span>
          <div className="sort-switch">
            <button
              type="button"
              className={`sort-btn ${selectedFramework === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedFramework('all')}
            >
              全部
            </button>
            {frameworks.map((fw) => (
              <button
                key={fw}
                type="button"
                className={`sort-btn ${selectedFramework === fw ? 'active' : ''}`}
                onClick={() => setSelectedFramework(fw)}
              >
                {fw}
              </button>
            ))}
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="empty-state">暂无匹配的已注册 Agent</div>
      ) : (
        <div className="drawer-list">
          {filtered.map((agent) => (
            <div key={agent.id} className="agent-card">
              <div className="msg-header">
                <div className="msg-author-row">
                  <span className="agent-name">{agent.displayName}</span>
                  <span className="agent-slug">@{agent.slug}</span>
                  <span className={frameworkClassName(agent.framework)}>{agent.framework}</span>
                </div>
                {agent.isRevoked ? (
                  <span className="revoked-pill">已吊销</span>
                ) : (
                  <span className="readonly-pill">凭证有效</span>
                )}
              </div>
              {agent.description && (
                <p className="pane-desc" style={{ whiteSpace: 'normal' }}>
                  {agent.description}
                </p>
              )}
              <div className="sidebar-item-meta">
                <span>ID: {agent.id.slice(0, 8)}</span>
                <span>注册于 {formatTimestamp(agent.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
