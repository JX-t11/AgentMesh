import { describe, expect, it, vi } from 'vitest';
import type { GroupMessagesPage, GroupMessageView, WsConnectionStatus } from '../types/domain';
import {
  applyIncomingGroupBatch,
  applyInitialGroupSnapshot,
  createGroupStreamState,
  GroupCatchUpCoordinator,
  RafBatcher,
  updateFollowingTail,
} from './groupBuffer';
import { ObserverSocketClient, type WebSocketLike } from './observerSocket';

function makeMsg(seq: number, groupId = 'g-1', replyTo: string | null = null): GroupMessageView {
  return {
    id: `msg-${seq}`,
    groupId,
    seq,
    senderAgentId: 'agent-1',
    clientMsgId: `c-${seq}`,
    content: `message #${seq}`,
    replyToMsgId: replyTo,
    mentionAgentIds: [],
    createdAt: '2026-11-16T02:00:00Z',
  };
}

describe('groupBuffer high-concurrency state engine', () => {
  it('merges out-of-order and duplicate frames strictly by monotonic seq and trims window in tail mode', () => {
    let state = createGroupStreamState('g-1');
    // 模拟先收到实时帧 seq=5,6，再返回初始快照 seq=1..=5
    state = applyIncomingGroupBatch(state, [makeMsg(6), makeMsg(5)], 5);
    state = applyInitialGroupSnapshot(
      state,
      {
        groupId: 'g-1',
        messages: [makeMsg(1), makeMsg(2), makeMsg(3), makeMsg(4), makeMsg(5)],
        hasMore: false,
      },
      5,
    );

    expect(state.messages.map((m) => m.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(state.lastSeq).toBe(6);
    expect(state.hasMoreBefore).toBe(true);
    expect(state.pendingUnreadCount).toBe(0);
  });

  it('locks viewport without trimming while inspecting history and resumes window on tail jump', () => {
    let state = createGroupStreamState('g-1');
    state = applyInitialGroupSnapshot(
      state,
      {
        groupId: 'g-1',
        messages: [makeMsg(1), makeMsg(2), makeMsg(3)],
        hasMore: false,
      },
      4,
    );

    // 用户向上滚动离开底部
    state = updateFollowingTail(state, false, 4);
    state = applyIncomingGroupBatch(state, [makeMsg(4), makeMsg(5), makeMsg(6)], 4);

    // 不裁剪头部 seq=1,2，以便当前阅读视口稳定，同时累计 3 条未读
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.pendingUnreadCount).toBe(3);

    // 点击跳回最新流：裁剪回窗口上限 4 条并清零未读计数
    state = updateFollowingTail(state, true, 4);
    expect(state.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6]);
    expect(state.pendingUnreadCount).toBe(0);
    expect(state.hasMoreBefore).toBe(true);
  });

  it('batches burst messages into a single animation frame flush', () => {
    let scheduledCb: (() => void) | null = null;
    const flushedBatches: GroupMessageView[][] = [];

    const batcher = new RafBatcher<GroupMessageView>(
      (items) => flushedBatches.push(items),
      {
        schedule: (cb) => {
          scheduledCb = cb;
          return 1;
        },
        cancel: () => {
          scheduledCb = null;
        },
      },
    );

    for (let s = 1; s <= 50; s += 1) {
      batcher.push(makeMsg(s));
    }
    expect(flushedBatches).toHaveLength(0);
    expect(scheduledCb).not.toBeNull();

    scheduledCb!();
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0]).toHaveLength(50);
  });

  it('recovers missed gaps across multiple after_seq pages via GroupCatchUpCoordinator', async () => {
    let state = createGroupStreamState('g-1');
    state = applyInitialGroupSnapshot(state, {
      groupId: 'g-1',
      messages: [makeMsg(1), makeMsg(2)],
      hasMore: false,
    });

    const pages: Record<number, GroupMessagesPage> = {
      2: { groupId: 'g-1', messages: [makeMsg(3), makeMsg(4)], hasMore: true },
      4: { groupId: 'g-1', messages: [makeMsg(5), makeMsg(6)], hasMore: false },
    };

    const coordinator = new GroupCatchUpCoordinator();
    const syncingLog: boolean[] = [];

    await coordinator.trigger(
      'g-1',
      () => state.lastSeq,
      {
        listGroupMessages(_gid, opts) {
          return Promise.resolve(pages[opts?.afterSeq ?? 0] ?? { groupId: 'g-1', messages: [], hasMore: false });
        },
      },
      (batch) => {
        state = applyIncomingGroupBatch(state, batch);
      },
      (syncing) => syncingLog.push(syncing),
    );

    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.lastSeq).toBe(6);
    expect(syncingLog).toEqual([true, false]);
  });
});

class FakeSocket implements WebSocketLike {
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
    this.onclose?.(new CloseEvent('close'));
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
    this.onmessage?.(new MessageEvent('message', { data: '{"type":"connected","role":"observer"}' }));
  }
}

describe('ObserverSocketClient dynamic group switching and reconnect', () => {
  it('subscribes single active group, keeps forum on group switch, and triggers catch-up on reconnect', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const statuses: WsConnectionStatus[] = [];
    const reconnectedGroups: Array<string | null> = [];

    const client = new ObserverSocketClient(
      {
        onStatusChange: (s) => statuses.push(s),
        onEvent: () => {},
        onReconnected: (gid) => reconnectedGroups.push(gid),
      },
      {
        url: 'ws://127.0.0.1:18890/api/v1/ws/observe',
        createSocket: () => {
          const s = new FakeSocket();
          sockets.push(s);
          return s;
        },
      },
    );

    client.setActiveGroup('group-a');
    client.connect();
    sockets[0].serverOpen();

    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      action: 'subscribe',
      groups: ['group-a'],
      forum: true,
    });

    // 切换到 group-b：退订 group-a 时绝不带 forum: true，随后订阅 group-b
    client.setActiveGroup('group-b');
    expect(JSON.parse(sockets[0].sent[1])).toEqual({
      action: 'unsubscribe',
      groups: ['group-a'],
    });
    expect(JSON.parse(sockets[0].sent[2])).toEqual({
      action: 'subscribe',
      groups: ['group-b'],
      forum: true,
    });

    // 模拟意外断线并触发指数退避重连
    sockets[0].close();
    expect(statuses[statuses.length - 1]).toBe('reconnecting');

    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    sockets[1].serverOpen();

    expect(JSON.parse(sockets[1].sent[0])).toEqual({
      action: 'subscribe',
      groups: ['group-b'],
      forum: true,
    });
    expect(reconnectedGroups).toEqual(['group-b']);

    client.dispose();
    vi.useRealTimers();
  });
});
