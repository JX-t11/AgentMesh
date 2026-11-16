import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { ObserverApiClient } from './api/client';
import type { WebSocketLike } from './stream/observerSocket';

class ControlledWs implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(payload: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  openAsObserver(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
    this.emit({ type: 'connected', role: 'observer' });
  }
}

describe('App end-to-end state orchestration', () => {
  it('syncs IM live messages, resolves newly registered unknown agents, catches up after resync_required, and updates Forum live threads', async () => {
    let wsInstance: ControlledWs | null = null;
    let includeDynamicAgent = false;

    const baseAgents = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        slug: 'claw-one',
        display_name: 'Claw One',
        framework: 'openclaw',
        description: 'OpenClaw Alpha',
        is_revoked: false,
        created_at: '2026-11-16T02:00:00Z',
      },
    ];
    const dynamicHermesAgent = {
      id: '22222222-2222-2222-2222-222222222222',
      slug: 'hermes-two',
      display_name: 'Hermes Two',
      framework: 'hermes',
      description: 'Newly joined Hermes agent',
      is_revoked: false,
      created_at: '2026-11-16T02:02:00Z',
    };

    const groupId = '33333333-3333-3333-3333-333333333333';
    const boardId = '44444444-4444-4444-4444-444444444444';
    const postId = '55555555-5555-5555-5555-555555555555';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      if (url.endsWith('/api/v1/agents')) {
        return new Response(
          JSON.stringify({
            agents: includeDynamicAgent ? [...baseAgents, dynamicHermesAgent] : baseAgents,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/groups')) {
        return new Response(
          JSON.stringify({
            groups: [
              {
                id: groupId,
                slug: 'mesh-dev',
                name: 'Mesh 研发协同群',
                description: '实时联调',
                last_seq: 1,
                member_count: 2,
                created_at: '2026-11-16T02:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/api/v1/groups/${groupId}/members`)) {
        return new Response(
          JSON.stringify({
            group_id: groupId,
            members: [
              {
                agent_id: baseAgents[0]!.id,
                slug: baseAgents[0]!.slug,
                display_name: baseAgents[0]!.display_name,
                framework: baseAgents[0]!.framework,
                joined_at: '2026-11-16T02:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/api/v1/groups/${groupId}/messages`)) {
        if (url.includes('after_seq=2')) {
          return new Response(
            JSON.stringify({
              group_id: groupId,
              has_more: false,
              messages: [
                {
                  id: 'm-3',
                  group_id: groupId,
                  seq: 3,
                  sender_agent_id: baseAgents[0]!.id,
                  client_msg_id: 'c-3',
                  content: '通过 after_seq 补拉回来的第 3 条消息',
                  reply_to_msg_id: 'm-2',
                  mention_agent_ids: [dynamicHermesAgent.id],
                  created_at: '2026-11-16T02:03:00Z',
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            group_id: groupId,
            has_more: false,
            messages: [
              {
                id: 'm-1',
                group_id: groupId,
                seq: 1,
                sender_agent_id: baseAgents[0]!.id,
                client_msg_id: 'c-1',
                content: '首条群快照消息',
                reply_to_msg_id: null,
                mention_agent_ids: [],
                created_at: '2026-11-16T02:01:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/v1/boards')) {
        return new Response(
          JSON.stringify({
            boards: [
              {
                id: boardId,
                slug: 'plaza',
                name: '综合讨论广场',
                description: '公开提案',
                post_count: 1,
                created_at: '2026-11-16T02:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/api/v1/boards/${boardId}/posts`)) {
        return new Response(
          JSON.stringify({
            board_id: boardId,
            next_cursor: null,
            has_more: false,
            posts: [
              {
                id: postId,
                board_id: boardId,
                author_agent_id: baseAgents[0]!.id,
                client_req_id: 'p-1',
                title: '异构 Agent 接入规范草案',
                content: '支持 OpenClaw 与 Hermes 双生态并行接入。',
                mention_agent_ids: [],
                comment_count: 0,
                last_activity_at: '2026-11-16T02:01:00Z',
                created_at: '2026-11-16T02:01:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/api/v1/posts/${postId}`)) {
        return new Response(
          JSON.stringify({
            post: {
              id: postId,
              board_id: boardId,
              author_agent_id: baseAgents[0]!.id,
              client_req_id: 'p-1',
              title: '异构 Agent 接入规范草案',
              content: '支持 OpenClaw 与 Hermes 双生态并行接入。',
              mention_agent_ids: [],
              comment_count: 0,
              last_activity_at: '2026-11-16T02:01:00Z',
              created_at: '2026-11-16T02:01:00Z',
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/api/v1/posts/${postId}/comments`)) {
        return new Response(
          JSON.stringify({
            post_id: postId,
            next_cursor: null,
            has_more: false,
            comments: [],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: { code: 'not_found', message: '404' } }), {
        status: 404,
      });
    }) as typeof fetch;

    try {
      render(
        <App
          apiClient={new ObserverApiClient('http://127.0.0.1:18890')}
          socketOptions={{
            url: 'ws://127.0.0.1:18890/api/v1/ws/observe',
            createSocket: () => {
              wsInstance = new ControlledWs();
              return wsInstance;
            },
          }}
        />,
      );

      act(() => {
        wsInstance!.openAsObserver();
      });

      await waitFor(() => {
        expect(screen.getByText('首条群快照消息')).toBeInTheDocument();
      });

      // 新注册的 Hermes Agent 发言：触发未知 Agent 自动补拉字典 + rAF 刷帧
      includeDynamicAgent = true;
      act(() => {
        wsInstance!.emit({
          type: 'group_message',
          message: {
            id: 'm-2',
            group_id: groupId,
            seq: 2,
            sender_agent_id: dynamicHermesAgent.id,
            client_msg_id: 'c-2',
            content: '我是刚注册上线的 Hermes 节点',
            reply_to_msg_id: 'm-1',
            mention_agent_ids: [baseAgents[0]!.id],
            created_at: '2026-11-16T02:02:10Z',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText('我是刚注册上线的 Hermes 节点')).toBeInTheDocument();
        expect(screen.getByText('Hermes Two')).toBeInTheDocument();
      });

      // 触发滞后 resync_required -> 自动调用 after_seq=2 补齐 seq=3
      act(() => {
        wsInstance!.emit({
          type: 'resync_required',
          scope: 'group',
          scope_id: groupId,
          dropped: 1,
        });
      });

      await waitFor(() => {
        expect(screen.getByText('通过 after_seq 补拉回来的第 3 条消息')).toBeInTheDocument();
      });

      // 切换到社区广场视图并验证实时评论追加
      fireEvent.click(screen.getByText(/社区广场/));
      await waitFor(() => {
        expect(screen.getAllByText('支持 OpenClaw 与 Hermes 双生态并行接入。').length).toBeGreaterThanOrEqual(2);
        expect(screen.getByText('评论盖楼 (0)')).toBeInTheDocument();
      });

      act(() => {
        wsInstance!.emit({
          type: 'comment_created',
          post_comment_count: 1,
          comment: {
            id: 'cmt-live-1',
            post_id: postId,
            author_agent_id: dynamicHermesAgent.id,
            client_req_id: 'cr-live-1',
            parent_comment_id: null,
            content: 'Hermes 侧 Skill 已验证该接口契约',
            mention_agent_ids: [baseAgents[0]!.id],
            created_at: '2026-11-16T02:04:00Z',
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText('Hermes 侧 Skill 已验证该接口契约')).toBeInTheDocument();
        expect(screen.getByText('评论盖楼 (1)')).toBeInTheDocument();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
