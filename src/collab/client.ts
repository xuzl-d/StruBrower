import type { ProjectDocument } from '../bim/types';
import type { DocumentDiff } from './diff';

export type CollabStatus = 'offline' | 'connecting' | 'online' | 'error';

export interface CollabUser {
  id: string;
  userId: string;
  name: string;
  role: string;
}

export interface CollabHandlers {
  onStatus: (status: CollabStatus) => void;
  onHello: (payload: { rev: number; document: ProjectDocument; users: CollabUser[]; role: string; clientId: string }) => void;
  onPatch: (payload: { rev: number; diff: DocumentDiff; from: string; userId: string; self: boolean }) => void;
  onDocument: (payload: { rev: number; document: ProjectDocument; userId: string }) => void;
  onPresence: (users: CollabUser[]) => void;
  onError: (message: string) => void;
}

/**
 * 协作客户端：自动重连 + 在线状态 + 差分补丁发送。
 * 仅浏览器环境可用（依赖 WebSocket 与 location）；SSR 时不会被调用。
 */
export class CollabClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private retries = 0;
  private reconnectTimer: number | null = null;
  /** 服务端分配的连接 id：用于识别自己补丁的回显（同一账号多标签页也能区分）。 */
  private clientId = '';

  constructor(
    private readonly projectId: string,
    private readonly token: string,
    private readonly handlers: CollabHandlers,
  ) {}

  get online(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.stopped = false;
    if (typeof WebSocket === 'undefined' || typeof location === 'undefined') {
      this.handlers.onStatus('offline');
      return;
    }
    this.handlers.onStatus('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws/projects/${encodeURIComponent(this.projectId)}?token=${encodeURIComponent(this.token)}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.handlers.onStatus('error');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.retries = 0;
      this.handlers.onStatus('online');
    });
    socket.addEventListener('message', (event) => this.dispatch(event.data));
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      this.handlers.onStatus('offline');
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      this.handlers.onStatus('error');
    });
  }

  /** 发送协作补丁；返回是否成功写出（离线时为 false，由调用方决定是否走 HTTP 保存）。 */
  sendPatch(diff: DocumentDiff): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify({ type: 'patch', diff }));
      return true;
    } catch {
      return false;
    }
  }

  requestSync(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'sync' }));
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.retries, 8000);
    this.retries += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private dispatch(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: {
      type?: string;
      rev?: number;
      document?: ProjectDocument;
      users?: CollabUser[];
      diff?: DocumentDiff;
      from?: string;
      userId?: string;
      clientId?: string;
      role?: string;
      message?: string;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'hello' && message.document && typeof message.rev === 'number') {
      this.clientId = message.clientId ?? '';
      this.handlers.onHello({
        rev: message.rev,
        document: message.document,
        users: message.users ?? [],
        role: message.role ?? 'viewer',
        clientId: this.clientId,
      });
      return;
    }
    if (message.type === 'presence') {
      this.handlers.onPresence(message.users ?? []);
      return;
    }
    if (message.type === 'patch' && message.diff && typeof message.rev === 'number') {
      this.handlers.onPatch({
        rev: message.rev,
        diff: message.diff,
        from: message.from ?? '',
        userId: message.userId ?? '',
        self: Boolean(this.clientId && message.from === this.clientId),
      });
      return;
    }
    if (message.type === 'doc' && message.document && typeof message.rev === 'number') {
      this.handlers.onDocument({
        rev: message.rev,
        document: message.document,
        userId: message.userId ?? '',
      });
      return;
    }
    if (message.type === 'error' && message.message) {
      this.handlers.onError(message.message);
    }
  }
}
