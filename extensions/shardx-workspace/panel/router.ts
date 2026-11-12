import type { CdpMultiplexer } from './cdp';
import type { TargetInfo } from './types';

export type SandboxStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export type SessionSandbox = {
  sessionId: string;
  profileId: string;
  profileName: string;
  status: SandboxStatus;
  cdpWsUrl: string | null;
  cdp: CdpMultiplexer | null;
  targets: TargetInfo[];
  activeTargetId: string | null;
  activeCdpSessionId: string | null;
  lastError: string | null;
  startedAt: number | null;
};

export type RouterBinding = {
  sessionId: string;
  profileId: string;
  profileName: string;
  status: SandboxStatus;
};

export class SessionIsolationError extends Error {
  code: string;

  constructor(message: string, code = 'ISOLATION') {
    super(message);
    this.name = 'SessionIsolationError';
    this.code = code;
  }
}

/**
 * Single source of truth for "which agent session owns which browser".
 *
 * Instances are keyed by profile id: a profile can be locked by at most one
 * session, but one session may own several browser instances (one per profile)
 * so the workspace can show them as separate browser-style tabs. Every CDP
 * socket and command queue still belongs to exactly one profile sandbox, so
 * two sessions can never drive the same browser and one browser is never
 * shared between two queues.
 */
export class SessionIsolationRouter {
  /** profileId -> sandbox */
  readonly instances = new Map<string, SessionSandbox>();
  /** profileId -> owning sessionId */
  readonly lockedProfiles = new Map<string, string>();
  private listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[ShardX] router listener failed', error);
      }
    }
  }

  owner(profileId: string): string | null {
    return this.lockedProfiles.get(profileId) ?? null;
  }

  getByProfile(profileId: string): SessionSandbox | null {
    return this.instances.get(profileId) ?? null;
  }

  allForSession(sessionId: string): SessionSandbox[] {
    return [...this.instances.values()].filter((sandbox) => sandbox.sessionId === sessionId);
  }

  /** Most recently started sandbox of a session (compatibility helper). */
  latest(sessionId: string): SessionSandbox | null {
    let found: SessionSandbox | null = null;
    for (const sandbox of this.instances.values()) {
      if (sandbox.sessionId !== sessionId) continue;
      if (!found || (sandbox.startedAt ?? 0) >= (found.startedAt ?? 0)) found = sandbox;
    }
    return found;
  }

  sessionIds(): string[] {
    const ids = new Set<string>();
    for (const sandbox of this.instances.values()) ids.add(sandbox.sessionId);
    return [...ids];
  }

  bindings(): RouterBinding[] {
    return [...this.instances.values()].map((sandbox) => ({
      sessionId: sandbox.sessionId,
      profileId: sandbox.profileId,
      profileName: sandbox.profileName,
      status: sandbox.status,
    }));
  }

  bindSession(sessionId: string, profileId: string, profileName = ''): SessionSandbox {
    if (!sessionId) throw new SessionIsolationError('缺少会话 ID', 'SESSION_REQUIRED');
    if (!profileId) throw new SessionIsolationError('缺少 profile ID', 'PROFILE_REQUIRED');

    const owner = this.owner(profileId);
    if (owner && owner !== sessionId) {
      throw new SessionIsolationError(
        `profile ${profileId} 已被会话 ${owner} 独占，先释放再绑定`,
        'PROFILE_LOCKED',
      );
    }

    const existing = this.instances.get(profileId);
    if (existing && existing.sessionId === sessionId) {
      existing.profileName = profileName || existing.profileName;
      this.lockedProfiles.set(profileId, sessionId);
      this.instances.delete(profileId);
      this.instances.set(profileId, existing);
      this.notify();
      return existing;
    }

    const sandbox: SessionSandbox = {
      sessionId,
      profileId,
      profileName: profileName || profileId,
      status: 'starting',
      cdpWsUrl: null,
      cdp: null,
      targets: [],
      activeTargetId: null,
      activeCdpSessionId: null,
      lastError: null,
      startedAt: null,
    };

    this.instances.set(profileId, sandbox);
    this.lockedProfiles.set(profileId, sessionId);
    this.notify();
    return sandbox;
  }

  /**
   * Move a running instance to another session without dropping its CDP
   * socket. Used when the mapping panel or an agent takes an instance over.
   */
  reassign(profileId: string, sessionId: string): SessionSandbox | null {
    if (!sessionId) throw new SessionIsolationError('缺少会话 ID', 'SESSION_REQUIRED');
    const sandbox = this.instances.get(profileId);
    if (!sandbox) return null;
    sandbox.sessionId = sessionId;
    this.lockedProfiles.set(profileId, sessionId);
    this.notify();
    return sandbox;
  }

  patch(profileId: string, patch: Partial<SessionSandbox>): SessionSandbox | null {
    const sandbox = this.instances.get(profileId);
    if (!sandbox) return null;
    Object.assign(sandbox, patch);
    this.notify();
    return sandbox;
  }

  attachCdp(profileId: string, cdpWsUrl: string, cdp: CdpMultiplexer): SessionSandbox {
    const sandbox = this.instances.get(profileId);
    if (!sandbox) throw new SessionIsolationError(`profile ${profileId} 未绑定会话`, 'NOT_BOUND');
    sandbox.cdp = cdp;
    sandbox.cdpWsUrl = cdpWsUrl;
    sandbox.status = 'running';
    sandbox.lastError = null;
    sandbox.startedAt = Date.now();
    this.notify();
    return sandbox;
  }

  markError(profileId: string, message: string): void {
    const sandbox = this.instances.get(profileId);
    if (!sandbox) return;
    sandbox.status = 'error';
    sandbox.lastError = message;
    this.notify();
  }

  unbindProfile(profileId: string): boolean {
    const sandbox = this.instances.get(profileId);
    if (!sandbox) return false;
    if (this.lockedProfiles.get(profileId) === sandbox.sessionId) {
      this.lockedProfiles.delete(profileId);
    }
    try {
      sandbox.cdp?.close();
    } catch {
      /* socket already gone */
    }
    this.instances.delete(profileId);
    this.notify();
    return true;
  }

  unbindSession(sessionId: string): string[] {
    const released: string[] = [];
    for (const sandbox of this.allForSession(sessionId)) {
      if (this.unbindProfile(sandbox.profileId)) released.push(sandbox.profileId);
    }
    return released;
  }

  clearAll(): void {
    for (const profileId of [...this.instances.keys()]) {
      this.unbindProfile(profileId);
    }
  }
}
