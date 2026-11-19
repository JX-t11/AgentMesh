import type { AgentView } from '../types/domain';

const COOLDOWN_MS = 10_000;

export class UnknownAgentRefresher {
  private readonly inFlight = new Set<string>();
  private readonly lastCheckedAt = new Map<string, number>();

  constructor(
    private readonly fetchAgent: (agentId: string) => Promise<AgentView>,
    private readonly onAgentFound: (agent: AgentView) => void,
  ) {}

  notifyUnknown(agentId: string, now = Date.now()): void {
    const last = this.lastCheckedAt.get(agentId);
    if (this.inFlight.has(agentId) || (last !== undefined && now - last < COOLDOWN_MS)) return;
    this.lastCheckedAt.set(agentId, now);
    this.inFlight.add(agentId);
    void this.fetchAgent(agentId)
      .then(this.onAgentFound)
      .catch(() => {})
      .finally(() => this.inFlight.delete(agentId));
  }
}
