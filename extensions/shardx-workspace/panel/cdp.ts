import { transport, TransportError } from './transport';

export type CdpEventHandler = (params: any, sessionId: string | null) => void;

type PendingCommand = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: number;
  method: string;
};

type EventBatch = {
  events?: any[];
  closed?: boolean;
  reason?: string;
  gap?: boolean;
};

const EVENT_WAIT_MS = 800;
const EVENT_POLL_FAILS_MAX = 4;

export class CdpError extends Error {
  code: number;
  data: unknown;

  constructor(message: string, code = 0, data: unknown = null) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
    this.data = data;
  }
}

function toCdpError(error: unknown, fallback: string): CdpError {
  if (error instanceof CdpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof TransportError ? error.code : '';
  return new CdpError(message || fallback, 0, code || null);
}

/**
 * One Chrome DevTools Protocol connection per bound browser instance.
 *
 * The socket itself lives in the host-spawned bridge service; this side only
 * writes frames (`/cdp/send`) and drains the responses and events that the
 * service queues (`/cdp/events`). Commands are still multiplexed by a
 * monotonic numeric id, so every call settles with that id's response.
 */
export class CdpMultiplexer {
  readonly key: string;
  private session: string | null = null;
  private open = false;
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private handlers = new Map<string, Set<CdpEventHandler>>();
  private anyHandlers = new Set<CdpEventHandler>();
  private closeHandlers = new Set<(reason: string) => void>();
  private pollStopped = false;

  constructor(key: string) {
    this.key = key;
  }

  isOpen(): boolean {
    return this.open && this.session !== null;
  }

  async connect(
    url: string,
    timeoutMs = 15000,
    headers?: Record<string, string>,
  ): Promise<void> {
    if (this.isOpen()) return;
    this.teardownSocket();

    let opened: { sessionId?: string };
    try {
      opened = await transport.call<{ sessionId?: string }>('/cdp/open', {
        url,
        timeoutMs,
        headers: headers ?? null,
      });
    } catch (error) {
      throw toCdpError(error, 'CDP 连接失败');
    }

    const sessionId = typeof opened.sessionId === 'string' ? opened.sessionId : '';
    if (!sessionId) throw new CdpError('桥接服务未返回 CDP 会话 ID', 0, 'BAD_RESPONSE');

    this.session = sessionId;
    this.open = true;
    this.pollStopped = false;
    void this.pollLoop(sessionId);
  }

  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string | null,
    timeoutMs = 20000,
  ): Promise<T> {
    const session = this.session;
    if (!this.open || !session) {
      return Promise.reject(new CdpError('CDP 未连接'));
    }

    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP 命令超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: any) => void,
        reject,
        timer,
        method,
      });

      transport
        .call('/cdp/send', { session, message })
        .catch((error) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          window.clearTimeout(timer);
          reject(toCdpError(error, `CDP 发送失败: ${method}`));
        });
    });
  }

  waitEvent<T = any>(
    method: string,
    predicate: ((params: T, sessionId: string | null) => boolean) | null = null,
    timeoutMs = 15000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const off = this.on(method, (params, sessionId) => {
        if (predicate && !predicate(params as T, sessionId)) return;
        window.clearTimeout(timer);
        off();
        resolve(params as T);
      });
      const timer = window.setTimeout(() => {
        off();
        reject(new CdpError(`等待事件超时: ${method}`));
      }, timeoutMs);
    });
  }

  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set && set.size === 0) this.handlers.delete(method);
    };
  }

  onAny(handler: CdpEventHandler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    const session = this.session;
    this.open = false;
    this.pollStopped = true;
    this.session = null;
    this.rejectAll(new CdpError('CDP 连接已主动关闭'));
    if (session) {
      transport.call('/cdp/close', { session }).catch(() => {
        /* the service already dropped it */
      });
    }
  }

  private teardownSocket(): void {
    const session = this.session;
    this.open = false;
    this.pollStopped = true;
    this.session = null;
    this.rejectAll(new CdpError('CDP 连接已重置'));
    if (session) {
      transport.call('/cdp/close', { session }).catch(() => {
        /* the service already dropped it */
      });
    }
  }

  private async pollLoop(session: string): Promise<void> {
    let failures = 0;
    while (!this.pollStopped && this.open && this.session === session) {
      let batch: EventBatch;
      try {
        batch = await transport.call<EventBatch>('/cdp/events', {
          session,
          waitMs: EVENT_WAIT_MS,
        });
        failures = 0;
      } catch (error) {
        if (this.session !== session || !this.open) return;
        const code = error instanceof TransportError ? error.code : '';
        if (code === 'NO_SESSION' || code === 'CDP_CLOSED') {
          this.connectionClosed(
            error instanceof Error ? error.message : 'CDP 会话已关闭',
          );
          return;
        }
        failures += 1;
        if (failures >= EVENT_POLL_FAILS_MAX) {
          this.connectionClosed(
            error instanceof Error ? error.message : 'CDP 事件通道中断',
          );
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250 * failures));
        continue;
      }

      if (this.session !== session || !this.open) return;

      for (const message of batch.events ?? []) {
        this.handleMessage(message);
      }

      if (batch.closed) {
        this.connectionClosed(batch.reason || 'CDP 连接已关闭');
        return;
      }
    }
  }

  private connectionClosed(reason: string): void {
    if (!this.open) return;
    this.open = false;
    this.pollStopped = true;
    this.session = null;
    this.rejectAll(new CdpError(reason));
    for (const handler of [...this.closeHandlers]) {
      try {
        handler(reason);
      } catch {
        /* listener failure never breaks the close path */
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private handleMessage(message: any): void {
    if (!message || typeof message !== 'object') return;

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      window.clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new CdpError(
            String(message.error.message ?? `CDP ${pending.method} 失败`),
            Number(message.error.code ?? 0),
            message.error.data ?? null,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method === 'string') {
      const params = message.params ?? {};
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
      const set = this.handlers.get(message.method);
      if (set) {
        for (const handler of [...set]) {
          try {
            handler(params, sessionId);
          } catch (error) {
            console.warn('[ShardX][CDP] handler error', message.method, error);
          }
        }
      }
      for (const handler of [...this.anyHandlers]) {
        try {
          handler(params, sessionId);
        } catch {
          /* ignore listener failure */
        }
      }
    }
  }
}

export async function enableCdpDomains(cdp: CdpMultiplexer, sessionId?: string): Promise<void> {
  const safe = async (method: string, params: Record<string, unknown> = {}) => {
    try {
      await cdp.send(method, params, sessionId, 8000);
    } catch (error) {
      console.warn('[ShardX][CDP] ' + method + ' 未启用', error);
    }
  };
  if (!sessionId) {
    // Page-scoped domains do not exist on the browser target; attaching to a
    // page later re-enables them with that page's session id.
    await safe('Target.setDiscoverTargets', { discover: true });
    return;
  }
  await safe('Page.enable');
  await safe('Runtime.enable');
  await safe('Network.enable');
  await safe('DOM.enable');
}
