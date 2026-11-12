import { HostRequestError } from '@openchamber/sdk';
import type { HostClient, GuestRequestMethod } from '@openchamber/sdk';
import type {
  Branch,
  Build,
  DeployRequest,
  ExecResult,
  GithubDeployRequest,
  LogLine,
  Me,
  MetricSeries,
  Org,
  Project,
  Region,
  Service,
  ServiceCreate,
  ServiceState,
} from './types';

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

export class Api {
  private host: HostClient;

  constructor(host: HostClient) {
    this.host = host;
  }

  private async call<T>(
    method: GuestRequestMethod,
    path: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
  ): Promise<T> {
    const cleanQuery: Record<string, string> = {};
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') cleanQuery[key] = String(value);
      }
    }
    let result: { status: number; body: string };
    try {
      result = await this.host.request({
        method,
        path,
        query: Object.keys(cleanQuery).length ? cleanQuery : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof HostRequestError) {
        const messages: Record<string, string> = {
          DISCONNECTED: 'InstaCloud 集成未连接，请在 设置 → 集成 中填写令牌。',
          NO_INTEGRATION: '未找到 InstaCloud 集成。',
          BAD_PATH: '请求路径不合法。',
          HOST_TIMEOUT: '请求超时（20 秒）。服务可能仍在后台执行。',
          RESPONSE_TOO_LARGE: '响应过大。',
          HOST_UNAVAILABLE: 'OpenChamber 主机不可用。',
        };
        throw new ApiError(messages[error.code] ?? `请求失败：${error.code}`, 0, error.code);
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
    if (result.status >= 400) {
      const message =
        errorText(text) ||
        (result.status === 401
          ? '令牌无效或已过期，请重新连接 InstaCloud 集成。'
          : result.status === 403
            ? '当前令牌没有执行此操作的权限。'
            : `请求失败（HTTP ${result.status}）。`);
      throw new ApiError(message, result.status);
    }
    return (parsed ?? {}) as T;
  }

  me(): Promise<Me> {
    return this.call<Me>('GET', '/me');
  }

  orgs(): Promise<{ orgs?: Org[] }> {
    return this.call<{ orgs?: Org[] }>('GET', '/orgs');
  }

  regions(): Promise<{ regions?: Region[] }> {
    return this.call<{ regions?: Region[] }>('GET', '/regions');
  }

  projects(orgId: string): Promise<{ projects?: Project[] }> {
    return this.call<{ projects?: Project[] }>(
      'GET',
      `/orgs/${encodeURIComponent(orgId)}/projects`,
    );
  }

  createProject(orgId: string, name: string): Promise<{ project?: Project }> {
    return this.call<{ project?: Project }>(
      'POST',
      `/orgs/${encodeURIComponent(orgId)}/projects`,
      undefined,
      { name },
    );
  }

  deleteProject(projectId: string): Promise<unknown> {
    return this.call<unknown>('DELETE', `/projects/${encodeURIComponent(projectId)}`);
  }

  branches(projectId: string): Promise<{ branches?: Branch[] }> {
    return this.call<{ branches?: Branch[] }>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/branches`,
    );
  }

  createBranch(
    projectId: string,
    body: { name: string; from?: string; empty?: boolean },
  ): Promise<unknown> {
    return this.call<unknown>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/branches`,
      undefined,
      body,
    );
  }

  deleteBranch(projectId: string, branchId: string): Promise<unknown> {
    return this.call<unknown>(
      'DELETE',
      `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}`,
    );
  }

  services(projectId: string): Promise<{ services?: Service[] }> {
    return this.call<{ services?: Service[] }>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/services`,
    );
  }

  createService(projectId: string, body: ServiceCreate): Promise<{ service?: Service }> {
    return this.call<{ service?: Service }>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/services`,
      undefined,
      body,
    );
  }

  deleteService(projectId: string, serviceId: string): Promise<unknown> {
    return this.call<unknown>(
      'DELETE',
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}`,
    );
  }

  async serviceAction(
    projectId: string,
    serviceId: string,
    action: 'start' | 'stop' | 'restart' | 'suspend',
  ): Promise<unknown> {
    try {
      return await this.call<unknown>(
        'POST',
        `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/${action}`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'HOST_TIMEOUT') return {};
      throw error;
    }
  }

  serviceState(projectId: string, serviceId: string): Promise<ServiceState> {
    return this.call<ServiceState>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/state`,
    );
  }

  deploy(projectId: string, body: DeployRequest): Promise<unknown> {
    return this.call<unknown>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/deploy`,
      undefined,
      body,
    );
  }

  githubDeploy(projectId: string, body: GithubDeployRequest): Promise<unknown> {
    return this.call<unknown>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/github/deploy`,
      undefined,
      body,
    );
  }

  builds(projectId: string, serviceId: string, limit = 10): Promise<{ builds?: Build[] }> {
    return this.call<{ builds?: Build[] }>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/builds`,
      { limit },
    );
  }

  redeploySource(projectId: string, serviceId: string): Promise<unknown> {
    return this.call<unknown>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/source/deploy`,
    );
  }

  logs(
    projectId: string,
    query: { component: string; group?: string; branch?: string; limit?: number },
  ): Promise<{ lines?: LogLine[]; note?: string; source?: string }> {
    return this.call<{ lines?: LogLine[]; note?: string; source?: string }>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/logs`,
      query,
    );
  }

  metrics(
    projectId: string,
    query: { component: string; group?: string; branch?: string; step?: string },
  ): Promise<{ series?: MetricSeries[]; note?: string; source?: string }> {
    return this.call<{ series?: MetricSeries[]; note?: string; source?: string }>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/metrics`,
      query,
    );
  }

  exec(
    projectId: string,
    serviceId: string,
    command: string[],
    timeoutSec = 15,
  ): Promise<ExecResult> {
    return this.call<ExecResult>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/exec`,
      undefined,
      { command, timeoutSec },
    );
  }
}
