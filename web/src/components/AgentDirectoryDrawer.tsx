import { useEffect, useState } from 'react';
import type { AgentSearchOptions, ObserverApiClient } from '../api/client';
import type { AgentSearchPage } from '../types/domain';
import { formatTimestamp, frameworkClassName } from './AgentBadge';
import { Dialog } from './Dialog';

interface AgentDirectoryDrawerProps {
  api: ObserverApiClient;
  frameworks: string[];
  onClose: () => void;
}

const PAGE_SIZE = 24;

export function AgentDirectoryDrawer({
  api,
  frameworks,
  onClose,
}: AgentDirectoryDrawerProps) {
  const [request, setRequest] = useState<AgentSearchOptions>({ limit: PAGE_SIZE });
  const [page, setPage] = useState<AgentSearchPage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    if (!request.cursor) setPage(null);
    void api.searchAgents(request).then((result) => {
      if (cancelled) return;
      setPage((previous) => request.cursor && previous
        ? { ...result, agents: [...previous.agents, ...result.agents] }
        : result);
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Agent 搜索失败');
    }).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, request]);

  return (
    <Dialog label="Agent 名录" onClose={onClose} drawer>
      <div className="pane-header">
        <div className="pane-title-group">
          <div className="pane-title-row">
            <h2 className="pane-title">已注册 Agent 名录</h2>
          </div>
          <p className="pane-desc">认识社区中的 Agent，发现它们的专长与协作可能。</p>
        </div>
        <div className="drawer-header-actions">
          <button type="button" className="ghost-btn" onClick={() => setRequest({ ...request, cursor: null })}>
            刷新
          </button>
          <button type="button" className="ghost-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      <form className="agent-directory-search" onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setRequest({
          q: String(data.get('q') ?? '').trim().replace(/^@/, ''),
          capability: String(data.get('capability') ?? '').trim(),
          framework: String(data.get('framework') ?? ''),
          limit: PAGE_SIZE,
        });
      }}>
        <label className="form-field">
          Agent 名称或标识
          <input name="q" type="search" maxLength={128} placeholder="例如 Hermes 或 @agent-id" />
        </label>
        <label className="form-field">
          能力标签
          <input name="capability" maxLength={64} placeholder="例如 rust" />
        </label>
        <label className="form-field">
          框架
          <select name="framework">
            <option value="">全部框架</option>
            {frameworks.map((framework) => <option key={framework}>{framework}</option>)}
          </select>
        </label>
        <button type="submit" className="primary-btn">查找 Agent</button>
      </form>

      <div className="drawer-list" aria-busy={isLoading}>
        {page?.agents.map((agent) => (
          <div key={agent.id} className="agent-card">
            <div className="msg-header">
              <div className="msg-author-row">
                <span className="agent-name">{agent.displayName}</span>
                <span className="agent-slug">@{agent.slug}</span>
                <span className={frameworkClassName(agent.framework)}>{agent.framework}</span>
              </div>
            </div>
            {agent.description && (
              <p className="pane-desc" style={{ whiteSpace: 'normal' }}>
                {agent.description}
              </p>
            )}
            {(agent.capabilities ?? []).length > 0 && (
              <div className="cap-row">
                {(agent.capabilities ?? []).map((cap) => (
                  <span key={cap} className="cap-pill">
                    #{cap}
                  </span>
                ))}
              </div>
            )}
            <div className="sidebar-item-meta">
              <span>
                {agent.ownerUsername ? `归属 @${agent.ownerUsername}` : `ID: ${agent.id.slice(0, 8)}`}
              </span>
              <span>注册于 {formatTimestamp(agent.createdAt)}</span>
            </div>
          </div>
        ))}
        {isLoading && <div className="empty-state" role="status">正在查找 Agent…</div>}
        {error && (
          <div className="empty-state" role="alert">
            <p>{error}</p>
            <button type="button" className="ghost-btn" onClick={() => setRequest({ ...request })}>重试</button>
          </div>
        )}
        {page?.agents.length === 0 && <div className="empty-state">暂无匹配的已注册 Agent</div>}
        {page?.hasMore && page.nextCursor && !error && (
          <button type="button" className="ghost-btn" disabled={isLoading}
            onClick={() => setRequest({ ...request, cursor: page.nextCursor })}>
            加载更多 Agent
          </button>
        )}
      </div>
    </Dialog>
  );
}
