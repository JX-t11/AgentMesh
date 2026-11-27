import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { AgentMeshClient, InboxEventView, resolveAgentMeshConfig } from './client.js';

export interface CursorState {
  lastInboxSeq: number;
  ackedInboxSeq: number;
  groupSeqs: Record<string, number>;
  processedKeys: string[];
}

export interface AgentRuntimePromptContext {
  kind: 'intent' | 'inbox';
  key: string;
  prompt: string;
}

export type TurnRunner = (ctx: AgentRuntimePromptContext) => Promise<void>;

const MAX_PROCESSED_KEYS = 512;

export class FileCursorStore {
  constructor(private readonly filePath: string) {}

  load(): CursorState {
    if (!existsSync(this.filePath)) {
      return { lastInboxSeq: 0, ackedInboxSeq: 0, groupSeqs: {}, processedKeys: [] };
    }
    const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<CursorState>;
    return {
      lastInboxSeq: typeof raw.lastInboxSeq === 'number' ? raw.lastInboxSeq : 0,
      ackedInboxSeq: typeof raw.ackedInboxSeq === 'number' ? raw.ackedInboxSeq : 0,
      groupSeqs: raw.groupSeqs && typeof raw.groupSeqs === 'object' ? raw.groupSeqs : {},
      processedKeys: Array.isArray(raw.processedKeys) ? raw.processedKeys : [],
    };
  }

  save(state: CursorState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const bounded: CursorState = {
      ...state,
      processedKeys: state.processedKeys.slice(-MAX_PROCESSED_KEYS),
    };
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(bounded, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}

export class AgentMeshBridgeDaemon {
  private stopped = false;
  private activeCatchUp: Promise<void> | null = null;
  private socket: WebSocket | null = null;

  constructor(
    private readonly client: AgentMeshClient,
    private readonly cursorStore: FileCursorStore,
    private readonly runTurn: TurnRunner,
    private readonly log: (event: Record<string, unknown>) => void = (e) => console.log(JSON.stringify(e)),
  ) {}

  async runOnceStartupAndIntent(initialIntent?: { id: string; prompt: string }): Promise<string> {
    const me = await this.client.whoami();
    const selfId = me.agent.id;
    await this.catchUpInbox(selfId);

    if (initialIntent && initialIntent.id.trim() && initialIntent.prompt.trim()) {
      const state = this.cursorStore.load();
      const key = `intent:${initialIntent.id.trim()}`;
      if (!state.processedKeys.includes(key)) {
        await this.runTurn({ kind: 'intent', key, prompt: initialIntent.prompt.trim() });
        state.processedKeys.push(key);
        this.cursorStore.save(state);
        this.log({ event: 'turn', status: 'completed', key, agent: me.agent.slug });
      }
    }
    return selfId;
  }

  async catchUpInbox(selfId: string): Promise<void> {
    if (this.activeCatchUp) {
      return this.activeCatchUp;
    }
    this.activeCatchUp = this.doCatchUpInbox(selfId).finally(() => {
      this.activeCatchUp = null;
    });
    return this.activeCatchUp;
  }

  private async doCatchUpInbox(selfId: string): Promise<void> {
    let state = this.cursorStore.load();
    let hasMore = true;

    while (hasMore && !this.stopped) {
      const page = await this.client.pollInbox({
        afterInboxSeq: state.lastInboxSeq,
        unreadOnly: false,
        limit: 100,
      });

      for (const item of page.items) {
        await this.processInboxEvent(selfId, item, state);
        state = this.cursorStore.load();
      }

      if (page.next_after_inbox_seq > state.lastInboxSeq) {
        state.lastInboxSeq = page.next_after_inbox_seq;
        this.cursorStore.save(state);
      }
      hasMore = page.has_more;
    }
  }

  async processInboxEvent(selfId: string, item: InboxEventView, state = this.cursorStore.load()): Promise<void> {
    const key = `inbox:${item.inbox_seq}`;
    if (state.processedKeys.includes(key)) {
      return;
    }

    if (item.actor_agent_id !== selfId) {
      const prompt = await this.buildWakePrompt(item);
      await this.runTurn({ kind: 'inbox', key, prompt });
      this.log({ event: 'turn', status: 'completed', key, kind: item.kind, inbox_seq: item.inbox_seq });
    }

    const ackRes = await this.client.ackInbox(item.inbox_seq);
    state.lastInboxSeq = Math.max(state.lastInboxSeq, item.inbox_seq);
    state.ackedInboxSeq = Math.max(state.ackedInboxSeq, ackRes.acked_inbox_seq);
    state.processedKeys.push(key);
    this.cursorStore.save(state);
  }

  private async buildWakePrompt(item: InboxEventView): Promise<string> {
    const parts = [
      `[AgentMesh Wakeup] event_kind=${item.kind} inbox_seq=${item.inbox_seq} actor_agent_id=${item.actor_agent_id}`,
    ];
    if (item.kind === 'dm_request') {
      parts.push(`dm_request_id=${item.source_id} summary=${JSON.stringify(item.summary)}`);
      parts.push(
        'Use agentmesh_respond_dm_request with action="accept" | "reject" | "block" to handle this DM handshake.',
      );
    } else if (item.kind === 'dm_accepted') {
      parts.push(
        `dm_request_id=${item.source_id} dm_group_id=${item.group_id ?? ''} summary=${JSON.stringify(item.summary)}`,
      );
      parts.push(
        'Your DM channel is now active; send private messages using agentmesh_send_group_message with group=dm_group_id.',
      );
    } else if (item.kind === 'dm_rejected') {
      parts.push(`dm_request_id=${item.source_id} summary=${JSON.stringify(item.summary)}`);
    } else if (item.group_id && item.source_id) {
      const msgPage = await this.client.readGroupMessages({ group: item.group_id, limit: 20 });
      const target = msgPage.messages.find((m) => m.id === item.source_id);
      if (item.kind === 'dm_message') {
        parts.push('channel_type=direct_message');
      }
      parts.push(`group_id=${item.group_id} target_message_id=${item.source_id}`);
      if (target) {
        parts.push(`target_message_seq=${target.seq} content=${JSON.stringify(target.content)}`);
      }
      parts.push(
        `Recent group history:\n${msgPage.messages
          .slice(-8)
          .map((m) => `- seq=${m.seq} id=${m.id} sender=${m.sender_agent_id}: ${m.content}`)
          .join('\n')}`,
      );
    }
    if (item.post_id) {
      const postDetail = await this.client.readForumPost({ postId: item.post_id, limit: 20 });
      parts.push(`post_id=${item.post_id} title=${JSON.stringify(postDetail.post.title)}`);
      if (item.source_id && item.source_id !== item.post_id) {
        const targetComment = postDetail.comments.find((c) => c.id === item.source_id);
        parts.push(`target_comment_id=${item.source_id}`);
        if (targetComment) {
          parts.push(`target_comment_content=${JSON.stringify(targetComment.content)}`);
        }
      } else {
        parts.push(`post_content=${JSON.stringify(postDetail.post.content)}`);
      }
    }
    parts.push(
      'Respond ONLY via your AgentMesh tools (using structured mentions and reply_to_msg_id / parent_comment_id as appropriate). If no action is needed, explain briefly without posting.',
    );
    return parts.join('\n');
  }

  async runForever(initialIntent?: { id: string; prompt: string }): Promise<void> {
    const selfId = await this.runOnceStartupAndIntent(initialIntent);
    this.log({ event: 'ready', runtime: 'openclaw', agent_id: selfId });

    let backoffMs = 500;
    while (!this.stopped) {
      try {
        await this.connectAndListen(selfId);
        backoffMs = 500;
      } catch (err) {
        if (this.stopped) break;
        this.log({ event: 'ws_error', message: err instanceof Error ? err.message : String(err) });
      }
      if (this.stopped) break;
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10_000);
      await this.catchUpInbox(selfId);
    }
  }

  private async connectAndListen(selfId: string): Promise<void> {
    const wsBase = this.client.baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    const url = `${wsBase}/api/v1/ws/agent?token=${encodeURIComponent(this.client.token)}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.socket = ws;

      let settled = false;
      const pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'ping' }));
        }
      }, 20_000);

      let chain: Promise<void> = Promise.resolve();

      ws.addEventListener('open', () => {
        chain = chain
          .then(() => this.catchUpInbox(selfId))
          .catch((err) => this.log({ event: 'catchup_error', message: String(err) }));
      });

      ws.addEventListener('message', (ev) => {
        let frame: { type?: string; scope?: string; event?: InboxEventView };
        try {
          frame = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (frame.type === 'inbox_event' && frame.event) {
          const event = frame.event;
          chain = chain
            .then(() => this.processInboxEvent(selfId, event))
            .catch((err) => this.log({ event: 'turn_error', message: String(err) }));
        } else if (frame.type === 'resync_required') {
          chain = chain
            .then(() => this.catchUpInbox(selfId))
            .catch((err) => this.log({ event: 'resync_error', message: String(err) }));
        }
      });

      ws.addEventListener('close', () => {
        clearInterval(pingTimer);
        this.socket = null;
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.addEventListener('error', (err) => {
        clearInterval(pingTimer);
        this.socket = null;
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error('WebSocket error'));
        }
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }
}

export function createOpenClawTurnRunner(opts: {
  binaryPath?: string;
  sessionId: string;
  rolePrompt?: string;
  agentId?: string;
}): TurnRunner {
  const bin = opts.binaryPath ?? process.env.OPENCLAW_BIN ?? 'openclaw';
  return async (ctx) => {
    const fullMessage = opts.rolePrompt
      ? `${opts.rolePrompt}\n\n---\n${ctx.prompt}`
      : ctx.prompt;

    const args = [
      '--no-color',
      'agent',
      '--local',
      '--json',
      '--session-id',
      opts.sessionId,
      ...(opts.agentId ? ['--agent', opts.agentId] : []),
      '--message',
      fullMessage,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      // Receipt lines must be extracted as chunks arrive: stderr is kept truncated
      // to the last 4000 chars, so waiting for close can lose receipts.
      const emitReceipts = (text: string) => {
        for (const line of text.split('\n')) {
          const match = line.match(/^\s*AGENTMESH_TOOL_RECEIPT (\{.*\})\s*$/);
          if (!match) {
            continue;
          }
          try {
            const receipt = JSON.parse(match[1]) as Record<string, unknown>;
            const event: Record<string, unknown> = {
              event: 'tool_receipt',
              turn: ctx.key,
              tool: receipt.tool,
              ok: receipt.ok,
              duration_ms: receipt.duration_ms,
            };
            if (receipt.args !== undefined) {
              event.args = receipt.args;
            }
            console.log(JSON.stringify(event));
          } catch {
            // ignore malformed receipt lines
          }
        }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        emitReceipts(text);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr = `${stderr}${text}`.slice(-4000);
        emitReceipts(text);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) {
          reject(new Error(`openclaw exited with code ${code}: ${stderr || stdout.slice(-1000)}`));
          return;
        }
        resolve();
      });
    });
  };
}

async function runCliDaemon(): Promise<void> {
  const client = new AgentMeshClient(resolveAgentMeshConfig());
  const stateDir = process.env.AGENTMESH_STATE_DIR ?? '/runtime-state';
  const slug = process.env.AGENTMESH_AGENT_SLUG ?? 'openclaw-agent';
  const store = new FileCursorStore(join(stateDir, slug, 'cursor.json'));
  const sessionId = process.env.OPENCLAW_SESSION_ID ?? '11111111-1111-4111-8111-111111111111';

  const runner = createOpenClawTurnRunner({
    sessionId,
    agentId: process.env.OPENCLAW_AGENT_ID,
    rolePrompt: process.env.AGENTMESH_ROLE_PROMPT,
  });

  const daemon = new AgentMeshBridgeDaemon(client, store, runner);
  process.on('SIGTERM', () => daemon.stop());
  process.on('SIGINT', () => daemon.stop());

  const intentPrompt = process.env.AGENTMESH_INITIAL_INTENT;
  const intentId = process.env.AGENTMESH_INTENT_ID;
  await daemon.runForever(
    intentPrompt && intentId ? { id: intentId, prompt: intentPrompt } : undefined,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCliDaemon().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
