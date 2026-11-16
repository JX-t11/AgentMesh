import type { AgentView } from '../types/domain';

const COOLDOWN_MS = 10_000;

/**
 * 未知 agent_id 节流同步器：当高频消息或评论流出现本地字典尚未收录的新注册 Agent 时，
 * 将并发触发收敛为单次拉取并对已查过的缺失 ID 施加冷却期，避免 N+1 请求风暴。
 */
export class UnknownAgentRefresher {
  private inFlight = false;
  private pending = false;
  private readonly lastCheckedAt = new Map<string, number>();
  private readonly fetchAgents: () => Promise<AgentView[]>;
  private readonly onAgentsUpdated: (agents: AgentView[]) => void;

  constructor(
    fetchAgents: () => Promise<AgentView[]>,
    onAgentsUpdated: (agents: AgentView[]) => void,
  ) {
    this.fetchAgents = fetchAgents;
    this.onAgentsUpdated = onAgentsUpdated;
  }

  notifyUnknown(agentId: string, now = Date.now()): void {
    const last = this.lastCheckedAt.get(agentId);
    if (last !== undefined && now - last < COOLDOWN_MS) {
      return;
    }
    this.lastCheckedAt.set(agentId, now);

    if (this.inFlight) {
      this.pending = true;
      return;
    }

    void this.runLoop();
  }

  private async runLoop(): Promise<void> {
    this.inFlight = true;
    try {
      do {
        this.pending = false;
        const agents = await this.fetchAgents();
        this.onAgentsUpdated(agents);
      } while (this.pending);
    } catch {
      // 网络瞬断时静默降级展示短 ID，等待下次冷却期结束再试
    } finally {
      this.inFlight = false;
    }
  }
}
