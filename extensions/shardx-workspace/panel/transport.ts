import type { GuestRequestResult, HostClient } from '@openchamber/sdk';

/**
 * The panel iframe cannot reach `http://127.0.0.1` directly: its CSP only
 * allows the guest-file origin, and manifest `origins` accepts https only.
 * Every byte to ShardX therefore travels over `host.serviceRequest` to the
 * extension's own loopback service (`service/main.ts`), which owns the real
 * HTTP calls and the persistent CDP WebSocket.
 */
export class TransportError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = 'TRANSPORT', status = 0) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.status = status;
  }
}

const HOST_ERROR_TEXT: Record<string, string> = {
  NO_SERVICE:
    'ShardX 桥接服务未运行。请在扩展设置中授予 service 能力并重启 OpenChamber。',
  UNSUPPORTED: '当前 OpenChamber 版本不支持扩展服务调用，请升级到 2.5.0 以上。',
  BAD_PATH: '桥接请求路径被宿主拒绝。',
  TIMEOUT: '桥接请求超时。',
};

function hostError(error: unknown): TransportError {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const known = HOST_ERROR_TEXT[code];
  if (known) return new TransportError(known, code);
  const message =
    typeof candidate?.message === 'string' && candidate.message.trim()
      ? candidate.message.trim()
      : String(error);
  return new TransportError(`扩展宿主调用失败：${message}`, code || 'HOST_REJECTED');
}

export class ServiceTransport {
  private host: HostClient | null = null;

  setHost(host: HostClient): void {
    this.host = host;
  }

  isReady(): boolean {
    return this.host !== null;
  }

  /**
   * One request/response round trip to the bridge service. The service answers
   * JSON in `body`; a non-2xx status is raised as a typed TransportError so
   * callers can branch on `code`.
   */
  async call<T>(path: string, payload: Record<string, unknown> = {}): Promise<T> {
    const host = this.host;
    if (!host) throw new TransportError('扩展宿主尚未连接', 'NO_HOST');

    let result: GuestRequestResult;
    try {
      result = await host.serviceRequest({
        method: 'POST',
        path,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw hostError(error);
    }

    let parsed: any = null;
    if (result.body) {
      try {
        parsed = JSON.parse(result.body);
      } catch {
        parsed = null;
      }
    }

    if (result.status < 200 || result.status >= 300) {
      const message =
        parsed && typeof parsed.error === 'string' && parsed.error.trim()
          ? parsed.error.trim()
          : `桥接服务返回 HTTP ${result.status}`;
      const code =
        parsed && typeof parsed.code === 'string' && parsed.code ? parsed.code : 'SERVICE_HTTP';
      throw new TransportError(message, code, result.status);
    }

    return (parsed ?? {}) as T;
  }
}

export const transport = new ServiceTransport();
