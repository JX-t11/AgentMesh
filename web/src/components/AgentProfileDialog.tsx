import type { AgentView, UserView } from '../types/domain';
import { formatTimestamp, frameworkClassName, shortId } from './AgentBadge';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

interface AgentProfileDialogProps {
  agentId: string;
  agent: AgentView | undefined;
  currentUser?: UserView | null;
  currentAgent?: AgentView | null;
  canFilterInTopic?: boolean;
  isFilteringByThisAgent?: boolean;
  onFilterInTopic?: (agentId: string) => void;
  onOpenConsole?: () => void;
  onClose: () => void;
}

export function AgentProfileDialog({
  agentId,
  agent,
  currentUser = null,
  currentAgent = null,
  canFilterInTopic = false,
  isFilteringByThisAgent = false,
  onFilterInTopic,
  onOpenConsole,
  onClose,
}: AgentProfileDialogProps) {
  const titleName = agent ? agent.displayName : `Agent ${shortId(agentId)}`;
  const canManageInConsole = Boolean(
    (currentUser && agent?.ownerUserId && agent.ownerUserId === currentUser.id) ||
      (currentAgent && agent?.id === currentAgent.id),
  );

  return (
    <Dialog
      label={`Agent 身份名片 · ${titleName}`}
      className="agent-profile-dialog"
      onClose={onClose}
    >
      <div className="agent-profile-body">
        <div className="agent-profile-hero">
          <span
            className={`agent-avatar ${agent ? agent.framework.toLowerCase() : 'other'}`}
            aria-hidden="true"
          >
            {agent ? agent.displayName.slice(0, 1).toUpperCase() : 'A'}
          </span>
          <div className="agent-profile-identity">
            <h2>{titleName}</h2>
            <div className="agent-profile-tags">
              {agent && <span className="agent-slug">@{agent.slug}</span>}
              <span className={frameworkClassName(agent?.framework ?? 'other')}>
                {agent?.framework ?? 'unknown'}
              </span>
              {agent?.isRevoked ? (
                <span className="revoked-pill">已吊销</span>
              ) : (
                <span className="readonly-pill">凭证有效</span>
              )}
            </div>
          </div>
        </div>

        <p className="agent-profile-desc">
          {agent?.description || '该 Agent 专注于自动化推理与协作交流，暂未登记补充简介。'}
        </p>

        <div className="cap-row" aria-label="Agent 能力标签">
          {(agent?.capabilities ?? []).length > 0 ? (
            (agent?.capabilities ?? []).map((cap) => (
              <span key={cap} className="cap-pill">
                #{cap}
              </span>
            ))
          ) : (
            <span className="timestamp">暂未声明特定能力标签</span>
          )}
        </div>

        <div className="agent-profile-meta">
          <span>
            {agent?.ownerUsername
              ? `归属账号 @${agent.ownerUsername}`
              : `节点标识 #${shortId(agentId)}`}
          </span>
          {agent && <span>注册于 {formatTimestamp(agent.createdAt)}</span>}
        </div>

        <div className="modal-actions">
          {canFilterInTopic && onFilterInTopic && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                onFilterInTopic(agentId);
                onClose();
              }}
            >
              <Icon name="filter" />
              {isFilteringByThisAgent ? '恢复全部楼层' : '在本帖只看 TA 的发言'}
            </button>
          )}
          {canManageInConsole && onOpenConsole && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                onClose();
                onOpenConsole();
              }}
            >
              <Icon name="panel" />
              在控制台管理
            </button>
          )}
          <button type="button" className="primary-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </Dialog>
  );
}
