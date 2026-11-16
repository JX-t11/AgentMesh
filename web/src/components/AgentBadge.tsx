import { useEffect } from 'react';
import type { AgentView } from '../types/domain';

export function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function frameworkClassName(framework: string): string {
  const normalized = framework.toLowerCase();
  if (normalized === 'openclaw') {
    return 'fw-pill openclaw';
  }
  if (normalized === 'hermes') {
    return 'fw-pill hermes';
  }
  return 'fw-pill other';
}

interface AgentBadgeProps {
  agentId: string;
  agentsById: ReadonlyMap<string, AgentView>;
  onUnknownAgent?: (agentId: string) => void;
}

export function AgentBadge({ agentId, agentsById, onUnknownAgent }: AgentBadgeProps) {
  const agent = agentsById.get(agentId);

  useEffect(() => {
    if (!agent && onUnknownAgent) {
      onUnknownAgent(agentId);
    }
  }, [agent, agentId, onUnknownAgent]);

  if (!agent) {
    return (
      <span className="agent-badge">
        <span className="agent-name">Agent {shortId(agentId)}</span>
        <span className="fw-pill other">unknown</span>
      </span>
    );
  }

  return (
    <span className="agent-badge">
      <span className="agent-name">{agent.displayName}</span>
      <span className="agent-slug">@{agent.slug}</span>
      <span className={frameworkClassName(agent.framework)}>{agent.framework}</span>
      {agent.isRevoked && <span className="revoked-pill">已吊销</span>}
    </span>
  );
}

interface MentionPillsProps {
  mentionAgentIds: string[];
  agentsById: ReadonlyMap<string, AgentView>;
  onUnknownAgent?: (agentId: string) => void;
}

export function MentionPills({
  mentionAgentIds,
  agentsById,
  onUnknownAgent,
}: MentionPillsProps) {
  useEffect(() => {
    if (!onUnknownAgent) {
      return;
    }
    for (const id of mentionAgentIds) {
      if (!agentsById.has(id)) {
        onUnknownAgent(id);
      }
    }
  }, [mentionAgentIds, agentsById, onUnknownAgent]);

  if (mentionAgentIds.length === 0) {
    return null;
  }

  return (
    <div className="mention-list" aria-label="提及列表">
      {mentionAgentIds.map((id) => {
        const target = agentsById.get(id);
        const label = target ? `@${target.slug} (${target.displayName})` : `@${shortId(id)}`;
        return (
          <span key={id} className="mention-pill">
            {label}
          </span>
        );
      })}
    </div>
  );
}
