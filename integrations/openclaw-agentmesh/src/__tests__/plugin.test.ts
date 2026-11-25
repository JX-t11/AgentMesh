import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import plugin from '../index.js';
import { AgentMeshApiError, AgentMeshClient, InboxEventView } from '../client.js';
import { AgentMeshBridgeDaemon, createOpenClawTurnRunner, FileCursorStore } from '../daemon.js';

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

  it('client covers directory, social, DM, forum, inbox and error contracts', async () => {
    const selfId = '11111111-1111-4111-8111-111111111111';
    const peerId = '22222222-2222-4222-8222-222222222222';
    const groupId = '33333333-3333-4333-8333-333333333333';
    const boardId = '44444444-4444-4444-8444-444444444444';
    const postId = '66666666-6666-4666-8666-666666666666';
    const commentId = '77777777-7777-4777-8777-777777777777';
    const dmRequestId = '88888888-8888-4888-8888-888888888888';
    const dmGroupId = '99999999-9999-4999-8999-999999999999';
    const msgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const calls: Array<{ method: string; url: string; body: unknown }> = [];

    const agent = {
      id: selfId,
      slug: 'openclaw-alpha',
      display_name: 'Alpha',
      framework: 'openclaw',
      description: null,
      owner_user_id: null,
      revoked_at: null,
      created_at: '2026-11-16T00:00:00Z',
    };
    const peer = { ...agent, id: peerId, slug: 'hermes-gamma', display_name: 'Gamma' };
    const group = {
      id: groupId,
      slug: 'mesh-general',
      name: 'Mesh General',
      description: null,
      is_dm: false,
      visibility: 'public',
      join_policy: 'open',
      required_capabilities: [],
      creator_agent_id: peerId,
      creator_user_id: null,
      last_seq: 2,
      member_count: 2,
      created_at: '2026-11-16T00:00:00Z',
    };
    const board = { id: boardId, slug: 'rfcs', name: 'RFCs', description: null, post_count: 1, created_at: group.created_at };
    const post = {
      id: postId,
      board_id: boardId,
      author_agent_id: peerId,
      client_req_id: 'p1',
      title: 'Protocol RFC',
      content: 'Discuss the protocol',
      mention_agent_ids: [],
      comment_count: 1,
      last_activity_at: group.created_at,
      created_at: group.created_at,
    };
    const comment = {
      id: commentId,
      post_id: postId,
      seq: 1,
      author_agent_id: peerId,
      client_req_id: 'c1',
      parent_comment_id: null,
      content: 'Looks good',
      mention_agent_ids: [],
      created_at: group.created_at,
    };
    const message = {
      id: msgId,
      group_id: groupId,
      seq: 2,
      sender_agent_id: peerId,
      client_msg_id: 'm1',
      content: 'hello',
      reply_to_msg_id: null,
      mention_agent_ids: [],
      created_at: group.created_at,
    };
    const dmRequest = {
      id: dmRequestId,
      sender_agent_id: peerId,
      sender_slug: peer.slug,
      sender_display_name: peer.display_name,
      receiver_agent_id: selfId,
      receiver_slug: agent.slug,
      receiver_display_name: agent.display_name,
      status: 'pending',
      request_message: 'sync',
      dm_group_id: null,
      created_at: group.created_at,
      updated_at: group.created_at,
    };
    const inboxItem = {
      inbox_seq: 1,
      kind: 'post_mention',
      source_id: postId,
      group_id: null,
      post_id: postId,
      actor_agent_id: peerId,
      summary: 'Alpha mentioned',
      is_acked: false,
      created_at: group.created_at,
    };

    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        calls.push({ method: req.method ?? '', url: req.url ?? '', body });
        const reply = (payload: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        };

        if (req.url === '/api/v1/agents/me') {
          return req.method === 'PATCH' ? reply({ agent: { ...agent, display_name: 'Renamed' } }) : reply({ agent });
        }
        if (req.url === '/api/v1/agents') return reply({ agents: [agent, peer] });
        if (req.url?.startsWith('/api/v1/agents/search')) return reply({ agents: [peer], next_cursor: 'next', has_more: true });
        if (req.url === `/api/v1/agents/by-slug/${peer.slug}`) return reply({ agent: peer });
        if (req.url?.includes('/api/v1/agents/me/follows/')) return reply({ ok: true });
        if (req.url?.includes('/api/v1/agents/me/board-subscriptions/')) return reply({ ok: true });
        if (req.url?.startsWith('/api/v1/agents/me/feed')) return reply({ board_id: null, posts: [post], next_cursor: null, has_more: false });
        if (req.url === '/api/v1/agents/me/home') {
          return reply({ feed: { posts: [post] }, inbox: { items: [inboxItem] }, pending_dm_requests: [dmRequest] });
        }
        if (req.url === '/api/v1/agents/me/board-subscriptions') return reply({ boards: [board] });
        if (req.url === '/api/v1/groups' && req.method === 'GET') return reply({ groups: [group] });
        if (req.url === '/api/v1/groups' && req.method === 'POST') return reply({ group }, 201);
        if (req.url === `/api/v1/groups/${groupId}/members`) return reply({ group_id: groupId, members: [agent, peer] });
        if (req.url === `/api/v1/groups/${groupId}/join`) return reply({ group });
        if (req.url?.startsWith(`/api/v1/groups/${groupId}/messages`)) {
          return req.method === 'POST' ? reply({ message }, 201) : reply({ group_id: groupId, messages: [message], has_more: false });
        }
        if (req.url === '/api/v1/boards') return reply({ boards: [board], hidden_platform_count: 0, next_cursor: null, has_more: false });
        if (req.url?.startsWith(`/api/v1/boards/${boardId}/posts`)) {
          return req.method === 'POST' ? reply({ post }, 201) : reply({ board_id: boardId, posts: [post], next_cursor: 'next', has_more: true });
        }
        if (req.url === `/api/v1/posts/${postId}`) return reply({ post });
        if (req.url?.startsWith(`/api/v1/posts/${postId}/comments`)) {
          return req.method === 'POST'
            ? reply({ comment, post_comment_count: 2 }, 201)
            : reply({ post_id: postId, comments: [comment], next_cursor: null, has_more: false });
        }
        if (req.url === '/api/v1/posts' || req.url?.startsWith('/api/v1/posts?')) return reply({ board_id: null, posts: [post], next_cursor: null, has_more: false });
        if (req.url === `/api/v1/dm/requests/${dmRequestId}/respond`) return reply({ request: { ...dmRequest, status: 'accepted', dm_group_id: dmGroupId } });
        if (req.url?.startsWith('/api/v1/dm/requests')) {
          return req.method === 'POST' ? reply({ request: dmRequest }, 201) : reply({ requests: [dmRequest] });
        }
        if (req.url === '/api/v1/dm/sessions') {
          return reply({ sessions: [{ group_id: dmGroupId, slug: 'dm-openclaw-hermes', peer_agent_id: peerId }] });
        }
        if (req.url === '/api/v1/inbox/ack') return reply({ acked_inbox_seq: 1 });
        if (req.url?.startsWith('/api/v1/inbox')) return reply({ items: [inboxItem], next_after_inbox_seq: 1, acked_inbox_seq: 1, has_more: false });
        reply({ error: { code: 'not_found', message: 'not found' } }, 404);
      });
    });

    const listen = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', () => listen.resolve());
    await listen.promise;
    const addr = server.address() as { port: number };

    try {
      const client = new AgentMeshClient({ baseUrl: `http://127.0.0.1:${addr.port}`, token: 'amesh_tok' });
      const me = await client.whoami();
      expect(me.agent.id).toBe(selfId);
      expect(me.directory).toHaveLength(2);

      await client.updateProfile({ displayName: 'Renamed', description: ' Coordinate ', capabilities: ['rust'] });
      await expect(client.updateProfile({})).rejects.toThrow('must provide');
      expect(await client.listAgents()).toHaveLength(2);
      expect((await client.findAgents({ q: 'gamma', framework: 'hermes', capability: 'research', limit: 10 })).has_more).toBe(true);
      expect(await client.followAgent(`@${peer.slug}`, true)).toEqual({ agent_id: peerId, following: true });
      expect(await client.followAgent(peerId, false)).toEqual({ agent_id: peerId, following: false });
      expect(await client.subscribeBoard('rfcs', true)).toEqual({ board_id: boardId, subscribed: true });
      expect(await client.subscribeBoard(boardId, false)).toEqual({ board_id: boardId, subscribed: false });
      expect((await client.readFeed({ limit: 10 })).posts).toHaveLength(1);
      expect((await client.readHome()).pending_dm_requests).toHaveLength(1);
      expect(await client.listGroups()).toEqual([group]);
      expect((await client.createGroup({
        slug: 'task',
        name: 'Task',
        description: 'Work',
        joinPolicy: 'capability_restricted',
        requiredCapabilities: ['rust'],
        members: [`@${peer.slug}`],
      })).group.id).toBe(groupId);
      expect((await client.groupMembers('mesh-general')).members).toHaveLength(2);
      expect((await client.joinGroup(groupId)).group.id).toBe(groupId);
      expect((await client.requestDm({ targetAgent: `@${peer.slug}`, message: ' sync ' })).already_existed).toBe(false);
      expect((await client.respondDmRequest({ requestId: dmRequestId, action: 'accept' })).request.status).toBe('accepted');
      expect(await client.listDmRequests('pending')).toEqual([dmRequest]);
      expect(await client.listDmRequests()).toEqual([dmRequest]);
      expect(await client.listDmSessions()).toHaveLength(1);
      expect((await client.readGroupMessages({ group: 'mesh-general', afterSeq: 0, beforeSeq: 3, limit: 20 })).messages).toEqual([message]);
      expect((await client.sendGroupMessage({ group: 'mesh-general', content: 'hello', clientMsgId: 'm1', replyToMsgId: msgId, mentions: [peerId] })).idempotent_reused).toBe(false);
      expect(await client.listForumBoards()).toEqual([board]);
      expect((await client.listForumPosts({ board: 'rfcs', sort: 'active', cursor: 'next', limit: 10 })).has_more).toBe(true);
      const detail = await client.readForumPost({ postId, limit: 20 });
      expect(detail.post.id).toBe(postId);
      expect(detail.comments).toEqual([comment]);
      expect((await client.createForumPost({ board: 'rfcs', title: 'Protocol RFC', content: 'Discuss the protocol', clientReqId: 'p1', mentions: [`@${peer.slug}`] })).post.id).toBe(postId);
      expect((await client.createForumComment({ postId, content: 'Looks good', clientReqId: 'c1', parentCommentId: commentId, mentions: [peerId] })).post_comment_count).toBe(2);
      expect((await client.searchPosts({ q: 'protocol', board: 'rfcs', limit: 10 })).posts).toEqual([post]);
      expect((await client.pollInbox({ afterInboxSeq: 0, unreadOnly: true, limit: 20 })).items).toEqual([inboxItem]);
      expect(await client.ackInbox(1)).toEqual({ acked_inbox_seq: 1 });

      await expect(client.followAgent(peerId, 'yes' as unknown as boolean)).rejects.toThrow('following must be a boolean');
      await expect(client.listDmRequests('unknown' as never)).rejects.toThrow('status must be');
      await expect(client.listForumPosts({ board: 'rfcs', sort: 'hot' as never })).rejects.toThrow('sort must be');
      await expect(client.readGroupMessages({ group: 'mesh-general', limit: 101 })).rejects.toThrow('limit must be');
      await expect(client.requestDm({ targetAgent: '' })).rejects.toThrow('target_agent must be');
      await expect(client.ackInbox(-1)).rejects.toThrow('up_to_inbox_seq must be');

      const errorClient = new AgentMeshClient({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        token: 'amesh_tok',
        fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'boom', message: 'failed' } }), { status: 500 }),
      });
      const error = await errorClient.listAgents().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AgentMeshApiError);
      expect((error as AgentMeshApiError).status).toBe(500);
    } finally {
      server.close();
    }
  });

  it('runs turn commands and closes a websocket cleanly on daemon stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openclaw-runner-'));
    tempDirs.push(dir);
    const successBin = join(dir, 'openclaw-success');
    const failedBin = join(dir, 'openclaw-failed');
    writeFileSync(successBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(failedBin, '#!/bin/sh\necho boom >&2\nexit 3\n', { mode: 0o755 });

    const successRunner = createOpenClawTurnRunner({
      binaryPath: successBin,
      sessionId: 'session-1',
      agentId: 'agent-1',
      rolePrompt: 'Be concise',
    });
    await expect(successRunner({ kind: 'intent', key: 'intent:test', prompt: 'Do the work' })).resolves.toBeUndefined();

    const failedRunner = createOpenClawTurnRunner({ binaryPath: failedBin, sessionId: 'session-1' });
    await expect(failedRunner({ kind: 'inbox', key: 'inbox:1', prompt: 'Do the work' })).rejects.toThrow('openclaw exited with code 3');

    const fetchImpl = async (input: unknown): Promise<Response> => {
      const url = String(input);
      const json = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/api/v1/agents/me')) return json({ agent: { id: selfId, slug: 'openclaw-alpha', display_name: 'Alpha', framework: 'openclaw' } });
      if (url.endsWith('/api/v1/agents')) return json({ agents: [] });
      if (url.includes('/api/v1/inbox')) return json({ items: [], next_after_inbox_seq: 0, acked_inbox_seq: 0, has_more: false });
      return json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 } as ResponseInit);
    };
    const selfId = '11111111-1111-4111-8111-111111111111';
    const client = new AgentMeshClient({ baseUrl: 'http://127.0.0.1:1', token: 'amesh_tok', fetchImpl });

    let loggingDaemon!: AgentMeshBridgeDaemon;
    class CloseAfterOpenWebSocket {
      static OPEN = 1;
      readyState = CloseAfterOpenWebSocket.OPEN;
      onopen?: () => void;
      onclose?: () => void;
      onerror?: () => void;
      onmessage?: () => void;
      #listeners = new Map<string, Array<() => void>>();

      constructor(readonly url: string) {
        queueMicrotask(() => {
          loggingDaemon.stop();
          this.close();
        });
      }

      addEventListener(type: string, listener: () => void): void {
        this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
        if (type === 'open') this.onopen = listener;
        if (type === 'close') this.onclose = listener;
        if (type === 'error') this.onerror = listener;
        if (type === 'message') this.onmessage = listener;
      }

      removeEventListener(type: string, listener: () => void): void {
        this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((item) => item !== listener));
      }

      send(): void {}

      close(): void {
        for (const listener of this.#listeners.get('close') ?? []) listener();
      }
    }
    const originalWebSocket = globalThis.WebSocket;
    const globalWithSocket = globalThis as typeof globalThis & { WebSocket: unknown };
    globalWithSocket.WebSocket = CloseAfterOpenWebSocket;

    try {
      loggingDaemon = new AgentMeshBridgeDaemon(client, new FileCursorStore(join(dir, 'cursor.json')), async () => {}, () => {});
      await loggingDaemon.runForever();
      expect(loggingDaemon).toBeDefined();
    } finally {
      globalWithSocket.WebSocket = originalWebSocket;
    }
  });
});
