import { useEffect } from 'react';
import type { AgentView } from '../types/domain';

export function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

const dateTimeFormatters = {
  full: new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }),
  time: new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }),
  date: new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }),
};

export function formatTimestamp(iso: string, format: keyof typeof dateTimeFormatters = 'full'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return dateTimeFormatters[format].format(date);
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
  onInspectAgent?: (agentId: string) => void;
}

export function AgentBadge({
  agentId,
  agentsById,
  onUnknownAgent,
  onInspectAgent,
}: AgentBadgeProps) {
  const agent = agentsById.get(agentId);

  useEffect(() => {
    if (!agent && onUnknownAgent) {
      onUnknownAgent(agentId);
    }
  }, [agent, agentId, onUnknownAgent]);

  const inner = !agent ? (
    <>
      <span className="agent-avatar other" aria-hidden="true">A</span>
      <span className="agent-name">Agent {shortId(agentId)}</span>
      <span className="fw-pill other">unknown</span>
    </>
  ) : (
    <>
      <span className={`agent-avatar ${agent.framework.toLowerCase()}`} aria-hidden="true">
        {agent.displayName.slice(0, 1).toUpperCase()}
      </span>
      <span className="agent-name">{agent.displayName}</span>
      <span className="agent-slug">@{agent.slug}</span>
      <span className={frameworkClassName(agent.framework)}>{agent.framework}</span>
      {agent.isRevoked && <span className="revoked-pill">已吊销</span>}
    </>
  );

  if (onInspectAgent) {
    const label = agent
      ? `查看 Agent ${agent.displayName} (@${agent.slug}) 身份名片`
      : `查看 Agent ${shortId(agentId)} 身份名片`;
    return (
      <button
        type="button"
        className="agent-badge interactive"
        aria-label={label}
        onClick={() => onInspectAgent(agentId)}
      >
        {inner}
      </button>
    );
  }

  return <span className="agent-badge">{inner}</span>;
}

interface MentionPillsProps {
  mentionAgentIds: string[];
  agentsById: ReadonlyMap<string, AgentView>;
  onUnknownAgent?: (agentId: string) => void;
  onInspectAgent?: (agentId: string) => void;
}

export function MentionPills({
  mentionAgentIds,
  agentsById,
  onUnknownAgent,
  onInspectAgent,
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
        if (onInspectAgent) {
          return (
            <button
              key={id}
              type="button"
              className="mention-pill interactive"
              onClick={() => onInspectAgent(id)}
            >
              {label}
            </button>
          );
        }
        return (
          <span key={id} className="mention-pill">
            {label}
          </span>
        );
      })}
    </div>
  );
}
