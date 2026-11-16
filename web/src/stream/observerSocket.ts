import { decodeObserverWsFrame } from '../api/decoders';
import type { ObserverWsEvent, WsConnectionStatus } from '../types/domain';

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  send(data: string): void;
  close(): void;
}

const WS_OPEN = 1;
const PING_INTERVAL_MS = 25_000;
const BASE_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 10_000;

export interface ObserverSocketHandlers {
  onStatusChange: (status: WsConnectionStatus) => void;
  onEvent: (event: ObserverWsEvent) => void;
  onReconnected?: (activeGroupId: string | null) => void;
}

export interface ObserverSocketOptions {
  url?: string;
  createSocket?: (url: string) => WebSocketLike;
}

export class ObserverSocketClient {
  private readonly url: string;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly handlers: ObserverSocketHandlers;
  private socket: WebSocketLike | null = null;
  private activeGroupId: string | null = null;
  private disposed = false;
  private hasConnectedOnce = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(handlers: ObserverSocketHandlers, opts: ObserverSocketOptions = {}) {
    this.handlers = handlers;
    this.url = opts.url ?? buildDefaultWsUrl();
    this.createSocket = opts.createSocket ?? ((url) => new WebSocket(url));
  }

  connect(): void {
    if (this.disposed || this.socket !== null) {
      return;
    }
    this.handlers.onStatusChange(this.hasConnectedOnce ? 'reconnecting' : 'connecting');
    const ws = this.createSocket(this.url);
    this.socket = ws;

    ws.onopen = () => {
      this.startPing();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        return;
      }
      let decoded: ObserverWsEvent;
      try {
        decoded = decodeObserverWsFrame(ev.data);
      } catch {
        return;
      }

      if (decoded.type === 'connected') {
        const isReconnect = this.hasConnectedOnce;
        this.hasConnectedOnce = true;
        this.reconnectAttempts = 0;
        this.handlers.onStatusChange('connected');
        this.sendJson({
          action: 'subscribe',
          groups: this.activeGroupId ? [this.activeGroupId] : [],
          forum: true,
        });
        if (isReconnect) {
          this.handlers.onReconnected?.(this.activeGroupId);
        }
      }

      this.handlers.onEvent(decoded);
    };

    ws.onerror = () => {
      // 交由紧随其后的 onclose 统一触发退避重连
    };

    ws.onclose = () => {
      this.stopPing();
      this.socket = null;
      if (this.disposed) {
        return;
      }
      this.handlers.onStatusChange('reconnecting');
      const delay = Math.min(BASE_RECONNECT_MS * 2 ** this.reconnectAttempts, MAX_RECONNECT_MS);
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    };
  }

  setActiveGroup(nextGroupId: string | null): void {
    const prevGroupId = this.activeGroupId;
    if (prevGroupId === nextGroupId) {
      return;
    }
    this.activeGroupId = nextGroupId;

    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      return;
    }

    if (prevGroupId) {
      // 服务端仅在 forum === true 时退订论坛流，切群退订不可传 forum: true。
      this.sendJson({
        action: 'unsubscribe',
        groups: [prevGroupId],
      });
    }
    if (nextGroupId) {
      this.sendJson({
        action: 'subscribe',
        groups: [nextGroupId],
        forum: true,
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      s.onclose = null;
      s.close();
    }
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.socket && this.socket.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendJson({ action: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

function buildDefaultWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/v1/ws/observe`;
}
