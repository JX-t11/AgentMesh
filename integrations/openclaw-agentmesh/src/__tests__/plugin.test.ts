import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import plugin from '../index.js';
import { AgentMeshClient, InboxEventView } from '../client.js';
import { AgentMeshBridgeDaemon, FileCursorStore } from '../daemon.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('openclaw-agentmesh plugin & client', () => {
  it('registers all 12 contract tools and resolves slugs to UUIDs at boundary', async () => {
    const selfId = '11111111-1111-4111-8111-111111111111';
    const peerId = '22222222-2222-4222-8222-222222222222';
    const groupId = '33333333-3333-4333-8333-333333333333';
    const boardId = '44444444-4444-4444-8444-444444444444';
    const capturedPosts: Array<{ url: string; body: unknown }> = [];

    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c.toString();
      });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/v1/agents' && req.method === 'GET') {
          res.end(
            JSON.stringify({
              agents: [
                { id: selfId, slug: 'openclaw-alpha', display_name: 'Alpha', framework: 'openclaw', description: null, revoked_at: null, created_at: '2026-11-16T00:00:00Z' },
                { id: peerId, slug: 'hermes-gamma', display_name: 'Gamma', framework: 'hermes', description: null, revoked_at: null, created_at: '2026-11-16T00:00:00Z' },
              ],
            }),
          );
          return;
        }
        if (req.url === '/api/v1/groups' && req.method === 'GET') {
          res.end(
            JSON.stringify({
              groups: [
                { id: groupId, slug: 'mesh-general', name: 'Mesh General', description: null, last_seq: 1, created_at: '2026-11-16T00:00:00Z' },
              ],
            }),
          );
          return;
        }
        if (req.url === `/api/v1/groups/${groupId}/messages` && req.method === 'POST') {
          const body = JSON.parse(raw);
          capturedPosts.push({ url: req.url, body });
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              message: {
                id: '55555555-5555-4555-8555-555555555555',
                group_id: groupId,
                seq: 2,
                sender_agent_id: selfId,
                client_msg_id: body.client_msg_id,
                content: body.content,
                reply_to_msg_id: body.reply_to_msg_id ?? null,
                mention_agent_ids: body.mention_agent_ids ?? [],
                created_at: '2026-11-16T00:00:00Z',
              },
            }),
          );
          return;
        }
        if (req.url === '/api/v1/boards' && req.method === 'GET') {
          res.end(
            JSON.stringify({
              boards: [{ id: boardId, slug: 'engineering-rfcs', name: 'RFCs', description: null, created_at: '2026-11-16T00:00:00Z' }],
            }),
          );
          return;
        }
        if (req.url === `/api/v1/boards/${boardId}/posts` && req.method === 'POST') {
          const body = JSON.parse(raw);
          capturedPosts.push({ url: req.url, body });
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              post: {
                id: '66666666-6666-4666-8666-666666666666',
                board_id: boardId,
                author_agent_id: selfId,
                client_req_id: body.client_req_id,
                title: body.title,
                content: body.content,
                mention_agent_ids: body.mention_agent_ids ?? [],
                comment_count: 0,
                last_activity_at: '2026-11-16T00:00:00Z',
                created_at: '2026-11-16T00:00:00Z',
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const tools = new Map<string, { execute: (id: string, p: any) => Promise<any> }>();
      plugin.register({
        pluginConfig: { baseUrl, token: 'amesh_test_token' },
        registerTool: (tool) => tools.set(tool.name, tool),
      });

      expect([...tools.keys()]).toHaveLength(12);

      const sendRes = await tools.get('agentmesh_send_group_message')!.execute('t1', {
        group: 'mesh-general',
        content: 'hello @hermes-gamma',
        client_msg_id: 'turn-1-msg',
        mentions: ['@hermes-gamma'],
      });

      expect(sendRes.details.idempotent_reused).toBe(false);
      expect(capturedPosts[0].body).toEqual({
        client_msg_id: 'turn-1-msg',
        content: 'hello @hermes-gamma',
        mention_agent_ids: [peerId],
      });

      await tools.get('agentmesh_create_forum_post')!.execute('t2', {
        board: 'engineering-rfcs',
        title: 'RFC 001',
        content: 'Discuss mesh protocol',
        client_req_id: 'rfc-1',
        mentions: ['hermes-gamma'],
      });
      expect(capturedPosts[1].body).toEqual({
        client_req_id: 'rfc-1',
        title: 'RFC 001',
        content: 'Discuss mesh protocol',
        mention_agent_ids: [peerId],
      });
    } finally {
      server.close();
    }
  });

  it('daemon filters self events, advances inbox ack, and skips processed events across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclaw-cursor-'));
    tempDirs.push(dir);
    const cursorFile = join(dir, 'cursor.json');

    const selfId = '11111111-1111-4111-8111-111111111111';
    const peerId = '22222222-2222-4222-8222-222222222222';
    const groupId = '33333333-3333-4333-8333-333333333333';
    const msgId = '55555555-5555-4555-8555-555555555555';

    const inboxItems: InboxEventView[] = [
      {
        inbox_seq: 1,
        kind: 'group_mention',
        source_id: '44444444-4444-4444-8444-444444444444',
        group_id: groupId,
        post_id: null,
        actor_agent_id: selfId,
        summary: 'self ping',
        is_acked: false,
        created_at: '2026-11-16T00:00:00Z',
      },
      {
        inbox_seq: 2,
        kind: 'group_mention',
        source_id: msgId,
        group_id: groupId,
        post_id: null,
        actor_agent_id: peerId,
        summary: '@openclaw-alpha please check',
        is_acked: false,
        created_at: '2026-11-16T00:00:01Z',
      },
    ];
    let ackedSeq = 0;

    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c.toString();
      });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/v1/agents/me') {
          res.end(
            JSON.stringify({
              agent: { id: selfId, slug: 'openclaw-alpha', display_name: 'Alpha', framework: 'openclaw', description: null, revoked_at: null, created_at: '2026-11-16T00:00:00Z' },
            }),
          );
          return;
        }
        if (req.url === '/api/v1/agents') {
          res.end(JSON.stringify({ agents: [] }));
          return;
        }
        if (req.url?.startsWith('/api/v1/inbox?')) {
          const url = new URL(req.url, 'http://localhost');
          const after = Number(url.searchParams.get('after_inbox_seq') ?? '0');
          const items = inboxItems.filter((item) => item.inbox_seq > after);
          res.end(
            JSON.stringify({
              items,
              next_after_inbox_seq: items.length > 0 ? items[items.length - 1].inbox_seq : after,
              acked_inbox_seq: ackedSeq,
              has_more: false,
            }),
          );
          return;
        }
        if (req.url === '/api/v1/inbox/ack' && req.method === 'POST') {
          const body = JSON.parse(raw);
          ackedSeq = Math.max(ackedSeq, body.up_to_inbox_seq);
          res.end(JSON.stringify({ acked_inbox_seq: ackedSeq }));
          return;
        }
        if (req.url?.startsWith(`/api/v1/groups/${groupId}/messages`)) {
          res.end(
            JSON.stringify({
              group_id: groupId,
              messages: [
                {
                  id: msgId,
                  group_id: groupId,
                  seq: 5,
                  sender_agent_id: peerId,
                  client_msg_id: 'c1',
                  content: '@openclaw-alpha please check',
                  reply_to_msg_id: null,
                  mention_agent_ids: [selfId],
                  created_at: '2026-11-16T00:00:01Z',
                },
              ],
              has_more: false,
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const client = new AgentMeshClient({ baseUrl: `http://127.0.0.1:${addr.port}`, token: 'amesh_tok' });

    try {
      const turns: string[] = [];
      const daemon1 = new AgentMeshBridgeDaemon(
        client,
        new FileCursorStore(cursorFile),
        async (ctx) => {
          turns.push(`${ctx.kind}:${ctx.key}`);
        },
        () => {},
      );
      await daemon1.runOnceStartupAndIntent({ id: 'intent-1', prompt: 'Start discussion' });
      expect(turns).toEqual(['inbox:inbox:2', 'intent:intent:intent-1']);
      expect(ackedSeq).toBe(2);

      // Restart with same cursor file: should NOT replay inbox:1, inbox:2, or intent-1
      const daemon2 = new AgentMeshBridgeDaemon(
        client,
        new FileCursorStore(cursorFile),
        async (ctx) => {
          turns.push(`restart:${ctx.key}`);
        },
        () => {},
      );
      await daemon2.runOnceStartupAndIntent({ id: 'intent-1', prompt: 'Start discussion' });
      expect(turns).toEqual(['inbox:inbox:2', 'intent:intent:intent-1']);
    } finally {
      server.close();
    }
  });
});
