import type { FetchGroupMessagesOptions } from '../api/client';
import type { GroupMessagesPage, GroupMessageView } from '../types/domain';

export const MAX_WINDOW_MESSAGES = 500;

export interface GroupStreamState {
  groupId: string;
  messages: GroupMessageView[];
  byId: Map<string, GroupMessageView>;
  hasMoreBefore: boolean;
  lastSeq: number;
  isFollowingTail: boolean;
  pendingUnreadCount: number;
  isResyncing: boolean;
}

export function createGroupStreamState(groupId: string): GroupStreamState {
  return {
    groupId,
    messages: [],
    byId: new Map(),
    hasMoreBefore: false,
    lastSeq: 0,
    isFollowingTail: true,
    pendingUnreadCount: 0,
    isResyncing: false,
  };
}

export function mergeGroupMessages(
  existing: GroupMessageView[],
  incoming: GroupMessageView[],
): { merged: GroupMessageView[]; addedAfterTail: number } {
  if (incoming.length === 0) {
    return { merged: existing, addedAfterTail: 0 };
  }

  const prevTailSeq = existing.length > 0 ? existing[existing.length - 1].seq : 0;

  // 热路径：入站消息严格接在当前尾部之后且自身严格升序时直接线性拼接，避免重排整个窗口。
  if (isStrictlyAscendingFrom(incoming, prevTailSeq)) {
    return {
      merged: existing.concat(incoming),
      addedAfterTail: incoming.length,
    };
  }

  const bySeq = new Map<number, GroupMessageView>();
  for (const msg of existing) {
    bySeq.set(msg.seq, msg);
  }
  let addedAfterTail = 0;
  for (const msg of incoming) {
    if (!bySeq.has(msg.seq) && msg.seq > prevTailSeq) {
      addedAfterTail += 1;
    }
    bySeq.set(msg.seq, msg);
  }

  const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  return { merged, addedAfterTail };
}

export function applyInitialGroupSnapshot(
  state: GroupStreamState,
  page: GroupMessagesPage,
  windowLimit = MAX_WINDOW_MESSAGES,
): GroupStreamState {
  if (page.groupId !== state.groupId) {
    return state;
  }
  const relevant = page.messages.filter((m) => m.groupId === state.groupId);
  const { merged } = mergeGroupMessages(state.messages, relevant);
  const trimmed = state.isFollowingTail && merged.length > windowLimit;
  const messages = trimmed ? merged.slice(merged.length - windowLimit) : merged;
  const lastSeq = messages.length > 0 ? messages[messages.length - 1].seq : state.lastSeq;
  const minSeq = messages.length > 0 ? messages[0].seq : 1;

  return {
    ...state,
    messages,
    byId: indexById(messages),
    hasMoreBefore: page.hasMore || trimmed || minSeq > 1,
    lastSeq: Math.max(state.lastSeq, lastSeq),
    pendingUnreadCount: state.isFollowingTail ? 0 : state.pendingUnreadCount,
  };
}

export function applyIncomingGroupBatch(
  state: GroupStreamState,
  incoming: GroupMessageView[],
  windowLimit = MAX_WINDOW_MESSAGES,
): GroupStreamState {
  const relevant = incoming.filter((m) => m.groupId === state.groupId);
  if (relevant.length === 0) {
    return state;
  }

  const { merged, addedAfterTail } = mergeGroupMessages(state.messages, relevant);
  const nextLastSeq =
    merged.length > 0 ? Math.max(state.lastSeq, merged[merged.length - 1].seq) : state.lastSeq;

  if (state.isFollowingTail) {
    const trimmed = merged.length > windowLimit;
    const messages = trimmed ? merged.slice(merged.length - windowLimit) : merged;
    return {
      ...state,
      messages,
      byId: indexById(messages),
      hasMoreBefore: state.hasMoreBefore || trimmed,
      lastSeq: nextLastSeq,
      pendingUnreadCount: 0,
    };
  }

  // 用户正在上滚回看历史：禁止裁剪头部消息，确保阅读视口锚点不发生跳动。
  return {
    ...state,
    messages: merged,
    byId: indexById(merged),
    lastSeq: nextLastSeq,
    pendingUnreadCount: state.pendingUnreadCount + addedAfterTail,
  };
}

export function applyOlderGroupHistory(
  state: GroupStreamState,
  page: GroupMessagesPage,
): GroupStreamState {
  if (page.groupId !== state.groupId) {
    return state;
  }
  const relevant = page.messages.filter((m) => m.groupId === state.groupId);
  const { merged } = mergeGroupMessages(state.messages, relevant);
  return {
    ...state,
    messages: merged,
    byId: indexById(merged),
    hasMoreBefore: page.hasMore,
  };
}

export function updateFollowingTail(
  state: GroupStreamState,
  following: boolean,
  windowLimit = MAX_WINDOW_MESSAGES,
): GroupStreamState {
  if (state.isFollowingTail === following && (!following || state.pendingUnreadCount === 0)) {
    return state;
  }
  if (!following) {
    return { ...state, isFollowingTail: false };
  }

  const trimmed = state.messages.length > windowLimit;
  const messages = trimmed
    ? state.messages.slice(state.messages.length - windowLimit)
    : state.messages;

  return {
    ...state,
    messages,
    byId: trimmed ? indexById(messages) : state.byId,
    hasMoreBefore: state.hasMoreBefore || trimmed,
    isFollowingTail: true,
    pendingUnreadCount: 0,
  };
}

export interface GroupMessagesReader {
  listGroupMessages(groupId: string, opts?: FetchGroupMessagesOptions): Promise<GroupMessagesPage>;
}

/**
 * 单群单飞追平协调器：当追平途中再次收到 resync_required 时合并为紧随其后的一轮补拉，避免并发风暴。
 */
export class GroupCatchUpCoordinator {
  private inFlight = false;
  private rerunRequested = false;
  private targetGroupId: string | null = null;

  async trigger(
    groupId: string,
    getLastSeq: () => number,
    api: GroupMessagesReader,
    onBatch: (messages: GroupMessageView[]) => void,
    onResyncStateChange?: (syncing: boolean) => void,
  ): Promise<void> {
    if (this.inFlight && this.targetGroupId === groupId) {
      this.rerunRequested = true;
      return;
    }

    this.targetGroupId = groupId;
    this.inFlight = true;
    this.rerunRequested = false;
    onResyncStateChange?.(true);

    try {
      do {
        this.rerunRequested = false;
        let cursor = getLastSeq();
        while (this.targetGroupId === groupId) {
          const page = await api.listGroupMessages(groupId, {
            afterSeq: cursor,
            limit: 100,
          });
          if (this.targetGroupId !== groupId) {
            return;
          }
          if (page.messages.length > 0) {
            cursor = page.messages[page.messages.length - 1].seq;
            onBatch(page.messages);
          }
          if (!page.hasMore || page.messages.length === 0) {
            break;
          }
        }
      } while (this.rerunRequested && this.targetGroupId === groupId);
    } finally {
      if (this.targetGroupId === groupId) {
        this.inFlight = false;
        onResyncStateChange?.(false);
      }
    }
  }

  reset(nextGroupId: string | null): void {
    this.targetGroupId = nextGroupId;
    this.inFlight = false;
    this.rerunRequested = false;
  }
}

export type FrameScheduler = {
  schedule: (cb: () => void) => number;
  cancel: (handle: number) => void;
};

const defaultScheduler: FrameScheduler = {
  schedule: (cb) => globalThis.requestAnimationFrame(cb),
  cancel: (handle) => globalThis.cancelAnimationFrame(handle),
};

export class RafBatcher<T> {
  private queue: T[] = [];
  private frameHandle: number | null = null;
  private readonly onFlush: (items: T[]) => void;
  private readonly scheduler: FrameScheduler;

  constructor(onFlush: (items: T[]) => void, scheduler: FrameScheduler = defaultScheduler) {
    this.onFlush = onFlush;
    this.scheduler = scheduler;
  }

  push(item: T): void {
    this.queue.push(item);
    if (this.frameHandle === null) {
      this.frameHandle = this.scheduler.schedule(() => {
        this.frameHandle = null;
        this.flushNow();
      });
    }
  }

  flushNow(): void {
    if (this.frameHandle !== null) {
      this.scheduler.cancel(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.queue.length === 0) {
      return;
    }
    const batch = this.queue;
    this.queue = [];
    this.onFlush(batch);
  }

  dispose(): void {
    if (this.frameHandle !== null) {
      this.scheduler.cancel(this.frameHandle);
      this.frameHandle = null;
    }
    this.queue = [];
  }
}

function isStrictlyAscendingFrom(items: GroupMessageView[], floorSeq: number): boolean {
  let prev = floorSeq;
  for (const item of items) {
    if (item.seq <= prev) {
      return false;
    }
    prev = item.seq;
  }
  return true;
}

function indexById(messages: GroupMessageView[]): Map<string, GroupMessageView> {
  const map = new Map<string, GroupMessageView>();
  for (const msg of messages) {
    map.set(msg.id, msg);
  }
  return map;
}
