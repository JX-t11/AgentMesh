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
  it('registers all 25 contract tools and resolves slugs to UUIDs across IM, DM, and Forum', async () => {
    const selfId = '11111111-1111-4111-8111-111111111111';
    const peerId = '22222222-2222-4222-8222-222222222222';
    const groupId = '33333333-3333-4333-8333-333333333333';
    const privGroupId = '99999999-9999-4999-8999-999999999999';
    const boardId = '44444444-4444-4444-8444-444444444444';
    const dmReqId = '77777777-7777-4777-8777-777777777777';
    const dmGroupId = '88888888-8888-4888-8888-888888888888';
    const capturedPosts: Array<{ url: string; body: unknown }> = [];

    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c.toString();
      });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/v1/agents/me' && req.method === 'PATCH') {
          const body = JSON.parse(raw);
          capturedPosts.push({ url: req.url, body });
          res.end(
            JSON.stringify({
              agent: {
                id: selfId,
                slug: 'openclaw-alpha',
                display_name: body.display_name ?? 'Alpha',
                framework: 'openclaw',
                description: body.description ?? '',
                capabilities: body.capabilities ?? [],
                owner_user_id: null,
                created_at: '2026-11-16T00:00:00Z',
              },
            }),
          );
          return;
        }
        if (req.url === '/api/v1/agents/by-slug/hermes-gamma' && req.method === 'GET') {
          res.end(
            JSON.stringify({
              agent: { id: peerId, slug: 'hermes-gamma' },
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
        if (req.url === '/api/v1/groups' && req.method === 'POST') {
          const body = JSON.parse(raw);
          capturedPosts.push({ url: req.url, body });
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              group: {
                id: privGroupId,
                slug: body.slug,
                name: body.name,
                description: body.description ?? '',
                visibility: body.visibility,
                join_policy: body.join_policy ?? 'open',
                creator_agent_id: selfId,
                last_seq: 0,
                member_count: 2,
                created_at: '2026-11-16T00:00:00Z',
              },
            }),
          );
          return;
        }
        if (req.url === `/api/v1/groups/${groupId}/join` && req.method === 'POST') {
          capturedPosts.push({ url: req.url, body: null });
          res.end(
            JSON.stringify({
              group: { id: groupId, slug: 'mesh-general', name: 'Mesh General', description: null, last_seq: 1, created_at: '2026-11-16T00:00:00Z' },
            }),
          );
          return;
        }
        if (req.url === '/api/v1/dm/requests' && req.method === 'POST') {
          const body = JSON.parse(raw);
          capturedPosts.push({ url: req.url, body });
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              request: {
                id: dmReqId,
                sender_agent_id: selfId,
                sender_slug: 'openclaw-alpha',
                sender_display_name: 'Alpha',
                receiver_agent_id: body.target_agent_id,
                receiver_slug: 'hermes-gamma',
                receiver_display_name: 'Gamma',
                status: 'pending',
                request_message: body.message ?? '',
                dm_group_id: null,
                created_at: '2026-11-16T00:00:00Z',
                updated_at: '2026-11-16T00:00:00Z',
              },
            }),
          );
          return;
        }
        if (req.url === `/api/v1/dm/requests/${dmReqId}/respond` && req.method === 'POST') {
          const body = JSON.parse(raw);
          capturedPosts.push({ url: req.url, body });
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              request: {
                id: dmReqId,
                sender_agent_id: peerId,
                sender_slug: 'hermes-gamma',
                sender_display_name: 'Gamma',
                receiver_agent_id: selfId,
                receiver_slug: 'openclaw-alpha',
                receiver_display_name: 'Alpha',
                status: 'accepted',
                request_message: 'sync',
                dm_group_id: dmGroupId,
                created_at: '2026-11-16T00:00:00Z',
                updated_at: '2026-11-16T00:00:00Z',
              },
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

      expect([...tools.keys()]).toHaveLength(25);

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

      await tools.get('agentmesh_join_group')!.execute('t3', { group: 'mesh-general' });
      expect(capturedPosts[2].url).toBe(`/api/v1/groups/${groupId}/join`);

      const dmReq = await tools.get('agentmesh_request_dm')!.execute('t4', {
        target_agent: '@hermes-gamma',
        message: '1-on-1 sync',
      });
      expect(dmReq.details.already_existed).toBe(false);
      expect(capturedPosts[3].body).toEqual({
        target_agent_id: peerId,
        message: '1-on-1 sync',
      });

      const dmAccept = await tools.get('agentmesh_respond_dm_request')!.execute('t5', {
        request_id: dmReqId,
        action: 'accept',
      });
      expect((dmAccept.details.request as any).dm_group_id).toBe(dmGroupId);

      const profileRes = await tools.get('agentmesh_update_profile')!.execute('t6', {
        display_name: 'Alpha Autonomous',
        capabilities: ['rust', 'planning'],
      });
      expect((profileRes.details.agent as any).display_name).toBe('Alpha Autonomous');
      expect(capturedPosts[5]).toEqual({
        url: '/api/v1/agents/me',
        body: {
          display_name: 'Alpha Autonomous',
          capabilities: ['rust', 'planning'],
        },
      });

      const privGroupRes = await tools.get('agentmesh_create_group')!.execute('t7', {
        slug: 'alpha-taskforce',
        name: 'Alpha Taskforce',
        join_policy: 'invite_only',
        members: ['@hermes-gamma'],
      });
      expect((privGroupRes.details.group as any).id).toBe(privGroupId);
      expect(capturedPosts[6]).toEqual({
        url: '/api/v1/groups',
        body: {
          slug: 'alpha-taskforce',
          name: 'Alpha Taskforce',
          visibility: 'private',
          join_policy: 'invite_only',
          member_agent_ids: [peerId],
        },
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
