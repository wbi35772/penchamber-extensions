import type { HostClient } from '@openchamber/sdk';
import type { Profile, Proxy, CdpStartResult, FingerprintTemplate, RunningProfile } from './types';
import { transport, TransportError } from './transport';

export class ApiError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status = 0, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type ErrorBody = { error?: unknown; message?: unknown; detail?: unknown };

function errorText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as ErrorBody;
    for (const value of [parsed.error, parsed.message, parsed.detail]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // not JSON
  }
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

export const PORT_KEY = 'shardx-api-port';
export const TOKEN_KEY = 'shardx-token';
const STORAGE_SCOPE = 'instance' as const;

function unwrapList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const key of ['profiles', 'data', 'items', 'proxies']) {
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }
  return [];
}

export type DiscoverResult = {
  found: boolean;
  running?: boolean;
  port?: number;
  token?: string;
  version?: string;
  apiEnabled?: boolean;
  dataRoot?: string;
  settingsPath?: string;
  reason?: string;
  detail?: string;
};

export class ShardXApiClient {
  private host: HostClient | null;
  private port = 40325;
  private token: string | null = null;
  private ready = false;

  constructor(host?: HostClient) {
    this.host = host ?? null;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    try {
      const storedPort = await this.host?.storage.get(PORT_KEY, { scope: STORAGE_SCOPE });
      const port = Number(storedPort);
      if (Number.isFinite(port) && port > 0) this.port = Math.trunc(port);
      const storedToken = await this.host?.storage.get(TOKEN_KEY, { scope: STORAGE_SCOPE });
      if (typeof storedToken === 'string' && storedToken.trim()) {
        this.token = storedToken.trim();
      }
    } catch (error) {
      console.warn('[ShardX] 读取本地设置失败，使用默认值', error);
    }
    this.ready = true;
  }

  getPort(): number {
    return this.port;
  }

  async setPort(port: number): Promise<void> {
    if (!Number.isFinite(port) || port <= 0) throw new ApiError('端口不合法', 0, 'BAD_PORT');
    this.port = Math.trunc(port);
    try {
      await this.host?.storage.set(PORT_KEY, this.port, { scope: STORAGE_SCOPE });
    } catch (error) {
      console.warn('[ShardX] 保存端口失败', error);
    }
  }

  hasToken(): boolean {
    return Boolean(this.token);
  }

  getToken(): string | null {
    return this.token;
  }

  /** Bearer header for the CDP socket, when ShardX protects it the same way. */
  authHeaders(): Record<string, string> | undefined {
    return this.token ? { Authorization: `Bearer ${this.token}` } : undefined;
  }

  async setToken(token: string | null): Promise<void> {
    this.token = token && token.trim() ? token.trim() : null;
    try {
      if (this.token) {
        await this.host?.storage.set(TOKEN_KEY, this.token, { scope: STORAGE_SCOPE });
      } else {
        await this.host?.storage.delete(TOKEN_KEY, { scope: STORAGE_SCOPE });
      }
    } catch (error) {
      console.warn('[ShardX] 保存 Token 失败', error);
    }
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Ask the bridge service to locate the local ShardX launcher.
   *
   * It reads `%APPDATA%\shardx-launcher\settings.json` and mints a bearer from
   * `api_secret`, so neither the install path nor the token has to be typed in.
   */
  discover(): Promise<DiscoverResult> {
    return transport.call<DiscoverResult>('/shardx/discover', {});
  }

  /** Apply a discovery result: persist port + token and switch this client over. */
  async applyDiscovered(info: DiscoverResult): Promise<void> {
    if (!info?.found) {
      throw new ApiError(info?.reason ?? '未在本机找到 ShardX 启动器配置', 0, 'NOT_FOUND');
    }
    if (typeof info.port === 'number' && info.port > 0) await this.setPort(info.port);
    if (typeof info.token === 'string' && info.token) await this.setToken(info.token);
  }

  private async call<T>(
    method: string,
    path: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
  ): Promise<T> {
    let result: { status: number; body: string; truncated?: boolean };
    try {
      result = await transport.call('/proxy', {
        baseUrl: this.baseUrl(),
        token: this.token ?? '',
        method,
        path,
        query: query ?? null,
        body: body === undefined ? null : body,
      });
    } catch (error) {
      if (error instanceof TransportError) {
        throw new ApiError(
          `无法连接 ShardX 本地 API（${this.baseUrl()}）。${error.message}`,
          0,
          error.code,
        );
      }
      throw error;
    }

    const text = result.body ?? '';
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (result.status < 200 || result.status >= 300) {
      const message = errorText(text) ||
        (result.status === 401 ? 'ShardX Token 无效或缺失，请在设置中填写 Bearer Token。' :
         result.status === 403 ? '当前 Token 没有执行此操作的权限。' :
         result.status === 404 ? '目标不存在（profile / proxy 可能已被删除）。' :
         `请求失败（HTTP ${result.status}）。`);
      throw new ApiError(message, result.status);
    }

    return (parsed ?? {}) as T;
  }

  connect(): Promise<unknown> {
    return this.health();
  }

  health(): Promise<unknown> {
    return this.call<unknown>('GET', '/health');
  }

  async profiles(folder?: string): Promise<Profile[]> {
    const raw = await this.call<unknown>('GET', '/profiles', folder ? { folder } : undefined);
    return unwrapList<Profile>(raw);
  }

  profile(id: string): Promise<Profile> {
    return this.call<Profile>('GET', `/profiles/${encodeURIComponent(id)}`);
  }

  createProfile(body: Record<string, unknown>): Promise<Profile> {
    return this.call<Profile>('POST', '/profiles', undefined, body);
  }

  updateProfile(id: string, body: Record<string, unknown>): Promise<Profile> {
    return this.call<Profile>('PATCH', `/profiles/${encodeURIComponent(id)}`, undefined, body);
  }

  deleteProfile(id: string): Promise<unknown> {
    return this.call<unknown>('DELETE', `/profiles/${encodeURIComponent(id)}`);
  }

  async startProfile(id: string): Promise<CdpStartResult> {
    const raw = await this.call<Record<string, unknown>>(
      'POST',
      `/profiles/${encodeURIComponent(id)}/start`,
    );
    return normalizeStartResult(raw);
  }

  stopProfile(id: string): Promise<unknown> {
    return this.call<unknown>('POST', `/profiles/${encodeURIComponent(id)}/stop`);
  }

  /**
   * Profiles that are already running. The bridge enriches every entry with a
   * CDP websocket, including browsers started from the launcher's own window
   * (their port is read from the profile's DevToolsActivePort file).
   */
  async running(): Promise<RunningProfile[]> {
    let raw: unknown;
    try {
      raw = await this.call<unknown>('POST', '/instances/running');
    } catch {
      raw = await this.call<unknown>('GET', '/running');
    }
    return unwrapList<Record<string, any>>(raw)
      .map(normalizeRunning)
      .filter((item): item is RunningProfile => item !== null);
  }

  /**
   * Make the launcher inject CDP flags into every browser it starts, so
   * instances opened from the launcher window become attachable too.
   */
  async ensureLauncherDebugArgs(): Promise<{ changed: boolean; extraArgs: string; debugEnabled: boolean }> {
    return this.call<{ changed: boolean; extraArgs: string; debugEnabled: boolean }>(
      'POST',
      '/launcher/settings',
      undefined,
      { ensure_debug: true },
    );
  }

  async proxies(): Promise<Proxy[]> {
    const raw = await this.call<unknown>('GET', '/proxies');
    return unwrapList<Proxy>(raw);
  }

  createProxy(body: Record<string, unknown>): Promise<Proxy> {
    return this.call<Proxy>('POST', '/proxies', undefined, body);
  }

  fingerprintTemplate(platform: 'win' | 'mac' | 'linux'): Promise<FingerprintTemplate> {
    return this.call<FingerprintTemplate>('GET', `/fingerprint/new/${platform}`);
  }
}

function firstString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeRunning(row: Record<string, any>): RunningProfile | null {
  if (!row || typeof row !== 'object') return null;
  const profileId =
    firstString(row.profile_id) ||
    firstString(row.profileId) ||
    firstString(row.id) ||
    firstString(row.profile?.id);
  if (!profileId) return null;
  const cdp = (row.cdp ?? row.CDP ?? {}) as Record<string, any>;
  const cdpWebSocketDebuggerUrl =
    firstString(row.web_socket_debugger_url) ||
    firstString(row.webSocketDebuggerUrl) ||
    firstString(row.ws_url) ||
    firstString(cdp.web_socket_debugger_url) ||
    firstString(cdp.webSocketDebuggerUrl) ||
    firstString(cdp.ws_url);
  const cdpHttpUrl =
    firstString(row.http_url) ||
    firstString(cdp.http_url) ||
    firstString(cdp.httpUrl) ||
    firstString(cdp.devtools_url);
  const pidRaw = Number(row.pid ?? cdp.pid);
  return {
    profileId,
    pid: Number.isFinite(pidRaw) && pidRaw > 0 ? Math.trunc(pidRaw) : null,
    cdpWebSocketDebuggerUrl,
    cdpHttpUrl,
    raw: row,
  };
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

export function normalizeStartResult(raw: Record<string, unknown>): CdpStartResult {
  const cdp = (raw.cdp ?? {}) as Record<string, unknown>;
  const wsUrl = pick(raw, 'cdp.web_socket_debugger_url', 'web_socket_debugger_url', 'wsUrl')
    ?? pick(cdp, 'web_socket_debugger_url', 'webSocketDebuggerUrl', 'ws_url', 'wsUrl');
  if (typeof wsUrl !== 'string' || !wsUrl) {
    throw new ApiError('启动响应中缺少 cdp.web_socket_debugger_url 字段', 0, 'BAD_RESPONSE');
  }
  return {
    cdpWebSocketDebuggerUrl: wsUrl,
    raw,
  };
}
