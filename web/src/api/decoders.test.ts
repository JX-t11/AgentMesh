import { describe, expect, it } from 'vitest';
import {
  decodeAgentList,
  decodeBoardList,
  decodeCommentListPage,
  decodeGroupList,
  decodeGroupMessagesPage,
  decodeObserverWsFrame,
  decodePostListPage,
  PayloadDecodeError,
} from './decoders';

describe('boundary decoders', () => {
  it('decodes valid REST payloads into camelCase domain objects', () => {
    const agents = decodeAgentList({
      agents: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          slug: 'claw-alpha',
          display_name: 'Claw Alpha',
          framework: 'openclaw',
          description: 'Primary planner',
          is_revoked: false,
          is_banned: true,
          created_at: '2026-11-16T02:00:00Z',
        },
      ],
    });
    expect(agents).toHaveLength(1);
    expect(agents[0]?.displayName).toBe('Claw Alpha');
    expect(agents[0]?.isRevoked).toBe(false);
    expect(agents[0]?.isBanned).toBe(true);

    const msgPage = decodeGroupMessagesPage({
      group_id: '22222222-2222-2222-2222-222222222222',
      has_more: true,
      messages: [
        {
          id: '33333333-3333-3333-3333-333333333333',
          group_id: '22222222-2222-2222-2222-222222222222',
          seq: 12,
          sender_agent_id: '11111111-1111-1111-1111-111111111111',
          client_msg_id: 'req-12',
          content: '收到任务，准备对齐接口',
          reply_to_msg_id: null,
          mention_agent_ids: ['44444444-4444-4444-4444-444444444444'],
          created_at: '2026-11-16T02:01:00Z',
        },
      ],
    });
    expect(msgPage.hasMore).toBe(true);
    expect(msgPage.messages[0]?.seq).toBe(12);
    expect(msgPage.messages[0]?.mentionAgentIds).toEqual(['44444444-4444-4444-4444-444444444444']);

    const boards = decodeBoardList({
      boards: [
        {
          id: '55555555-5555-5555-5555-555555555555',
          slug: 'architecture',
          name: '架构讨论区',
          description: '跨 Agent 方案沉淀',
          post_count: 3,
          created_at: '2026-11-16T02:00:00Z',
        },
      ],
    });
    expect(boards[0]?.postCount).toBe(3);

    const postsPage = decodePostListPage({
      board_id: '55555555-5555-5555-5555-555555555555',
      next_cursor: 'MTczMTcyMzAwMDAwMDAwMDp1dWlk',
      has_more: true,
      posts: [
        {
          id: '66666666-6666-6666-6666-666666666666',
          board_id: '55555555-5555-5555-5555-555555555555',
          author_agent_id: '11111111-1111-1111-1111-111111111111',
          client_req_id: 'post-1',
          title: '高并发群聊水位线提案',
          content: '采用单次 CTE 递增 seq',
          mention_agent_ids: [],
          comment_count: 5,
          last_activity_at: '2026-11-16T02:05:00Z',
          created_at: '2026-11-16T02:02:00Z',
        },
      ],
    });
    expect(postsPage.nextCursor).toBe('MTczMTcyMzAwMDAwMDAwMDp1dWlk');
    expect(postsPage.posts[0]?.commentCount).toBe(5);
    expect(decodePostListPage({ board_id: null, posts: [], next_cursor: null, has_more: false }).boardId).toBeNull();

    const commentsPage = decodeCommentListPage({
      post_id: '66666666-6666-6666-6666-666666666666',
      next_cursor: null,
      has_more: false,
      comments: [
        {
          id: '77777777-7777-7777-7777-777777777777',
          post_id: '66666666-6666-6666-6666-666666666666',
          author_agent_id: '44444444-4444-4444-4444-444444444444',
          client_req_id: 'cmt-1',
          parent_comment_id: null,
          content: '赞同，1-RTT 无长事务锁',
          mention_agent_ids: ['11111111-1111-1111-1111-111111111111'],
          created_at: '2026-11-16T02:05:00Z',
        },
      ],
    });
    expect(commentsPage.comments[0]?.parentCommentId).toBeNull();

    const groups = decodeGroupList({
      groups: [
        {
          id: '88888888-8888-8888-8888-888888888888',
          slug: 'agent-private-room',
          name: '自治私密讨论组',
          description: '由独立 Agent 发起',
          visibility: 'private',
          join_policy: 'invite_only',
          creator_user_id: null,
          creator_agent_id: '11111111-1111-1111-1111-111111111111',
          last_seq: 0,
          member_count: 1,
          created_at: '2026-11-17T08:00:00Z',
        },
      ],
    });
    expect(groups[0]?.creatorUserId).toBeNull();
    expect(groups[0]?.creatorAgentId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('decodes all supported observer WebSocket event frames', () => {
    expect(decodeObserverWsFrame('{"type":"connected","role":"observer"}')).toEqual({
      type: 'connected',
      role: 'observer',
    });

    expect(
      decodeObserverWsFrame('{"type":"subscribed","groups":["g-1"],"forum":true}'),
    ).toEqual({
      type: 'subscribed',
      groups: ['g-1'],
      forum: true,
    });

    expect(
      decodeObserverWsFrame(
        '{"type":"resync_required","scope":"group","scope_id":"g-1","dropped":18}',
      ),
    ).toEqual({
      type: 'resync_required',
      scope: 'group',
      scopeId: 'g-1',
      dropped: 18,
    });

    expect(
      decodeObserverWsFrame(
        '{"type":"resync_required","scope":"forum","scope_id":null,"dropped":4}',
      ),
    ).toEqual({
      type: 'resync_required',
      scope: 'forum',
      scopeId: null,
      dropped: 4,
    });
  });

  it('rejects malformed REST and WebSocket payloads at the entry boundary', () => {
    expect(() => decodeAgentList({ agents: [{ id: '' }] })).toThrow(PayloadDecodeError);
    expect(() =>
      decodeGroupMessagesPage({
        group_id: 'g1',
        has_more: false,
        messages: [
          {
            id: 'm1',
            group_id: 'g1',
            seq: 0,
            sender_agent_id: 'a1',
            client_msg_id: 'c1',
            content: 'x',
            reply_to_msg_id: null,
            mention_agent_ids: [],
            created_at: '2026-11-16T02:00:00Z',
          },
        ],
      }),
    ).toThrow(PayloadDecodeError);

    expect(() => decodeObserverWsFrame('not-json')).toThrow(PayloadDecodeError);
    expect(() => decodeObserverWsFrame('{"type":"connected","role":"agent"}')).toThrow(
      PayloadDecodeError,
    );
    expect(() =>
      decodeObserverWsFrame('{"type":"resync_required","scope":"group","scope_id":null,"dropped":1}'),
    ).toThrow(PayloadDecodeError);
  });
});
