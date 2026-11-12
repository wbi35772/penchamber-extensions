/**
 * Host-protocol shim for a guest extension embedded inside a Matrix tab.
 *
 * A guest panel normally talks to the OpenChamber host through
 * `window.parent`. Here its parent is our panel, not the host, so the shim
 * answers the same wire protocol and forwards every privileged call to the
 * real host through the Matrix service. The nested guest keeps its own CSP and
 * opaque origin; only structured messages cross the boundary.
 */

import type {
  AttachIssueRequest,
  FileEditorDocument,
  GenerateRequest,
  GuestConnection,
  GuestItem,
  GuestRequest,
  GuestSettings,
  GuestShellsScope,
  GuestWorkspaceQuery,
  HostClient,
  HostReadyContext,
  SessionLifecycleEvent,
} from '@openchamber/sdk';
import type { GuestServiceRequest, GuestServiceResult } from '../shared/types.ts';

const CHANNEL = 'openchamber.sdk';
const VERSION = 1;

interface GuestCall {
  channel?: unknown;
  v?: unknown;
  type?: unknown;
  id?: unknown;
  payload?: unknown;
}

export interface GuestBridgeOptions {
  frame: HTMLIFrameElement;
  ready: () => HostReadyContext | null;
  host: HostClient;
  /** A synthetic document for file-editor guests opened without a real file. */
  file?: FileEditorDocument;
  serviceRequest: (request: GuestServiceRequest) => Promise<GuestServiceResult>;
  serviceStatus: () => Promise<unknown>;
  storage: (request: unknown) => Promise<unknown>;
  openSurface?: (surfaceId: string) => Promise<void>;
  onLateGenerateListen?: () => void;
  close: () => void;
  onStatus?: (text: string) => void;
}

export interface GuestBridge {
  sendReady(): void;
  sendSession(session: unknown): void;
  sendSessionLifecycle(event: SessionLifecycleEvent): void;
  sendDirectory(directory: string | null): void;
  sendConnection(connection: GuestConnection): void;
  sendSettings(settings: GuestSettings): void;
  sendItem(item: GuestItem | null): void;
  sendGenerateLate(result: unknown): void;
  dispose(): void;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

interface SharedSubscription {
  refs: number;
  snapshot: unknown;
  hasSnapshot: boolean;
  listeners: Set<(snapshot: unknown) => void>;
  off: () => void;
}

/**
 * One host subscription shared by every embedded panel that asks for the same
 * scope. The host caps a frame at 32 subscriptions, so N guests watching the
 * same project must not consume N slots.
 */
const sharedSubscriptions = new Map<string, SharedSubscription>();

export function createGuestBridge(options: GuestBridgeOptions): GuestBridge {
  let disposed = false;
  const subscriptions = new Map<string, () => void>();

  const post = (message: unknown): void => {
    if (disposed) return;
    const target = options.frame.contentWindow;
    if (!target) return;
    target.postMessage(message, '*');
  };

  const readyContext = (): HostReadyContext | null => {
    const base = options.ready();
    if (!base) return null;
    const features: NonNullable<HostReadyContext['features']> = {};
    if (base.features?.deviceStorage === true) features.deviceStorage = true;
    if (base.features?.lateGenerateResults === true) features.lateGenerateResults = true;
    return {
      theme: base.theme,
      locale: base.locale,
      directory: base.directory,
      session: base.session,
      surface: 'panel',
      connection: base.connection,
      settings: base.settings ?? {},
      item: null,
      ...(Object.keys(features).length > 0 ? { features } : {}),
    };
  };

  const sendReady = (): void => {
    const context = readyContext();
    if (!context) return;
    post({ channel: CHANNEL, v: VERSION, type: 'ready', payload: context });
    options.onStatus?.('已连接宿主桥');
  };

  const reply = (id: unknown, payload: unknown): void => {
    if (typeof id !== 'string' || !id) return;
    post({ channel: CHANNEL, v: VERSION, type: 'result', id, ok: true, payload });
  };

  const fail = (id: unknown, code: string, error: string): void => {
    if (typeof id !== 'string' || !id) return;
    post({ channel: CHANNEL, v: VERSION, type: 'result', id, ok: false, code, error });
  };

  const subscribeShared = async (
    key: string,
    subscriptionId: string,
    factory: (listener: (snapshot: unknown) => void) => Promise<() => void>,
    listener: (snapshot: unknown) => void,
  ): Promise<void> => {
    let entry = sharedSubscriptions.get(key);
    if (!entry) {
      const created: SharedSubscription = {
        refs: 0,
        snapshot: undefined,
        hasSnapshot: false,
        listeners: new Set(),
        off: () => undefined,
      };
      sharedSubscriptions.set(key, created);
      created.off = await factory((snapshot) => {
        created.snapshot = snapshot;
        created.hasSnapshot = true;
        for (const fn of created.listeners) {
          try {
            fn(snapshot);
          } catch {
            /* one guest listener must not starve the others */
          }
        }
      });
      entry = created;
    }
    entry.refs += 1;
    entry.listeners.add(listener);
    const shared = entry;
    if (shared.hasSnapshot) {
      const cached = shared.snapshot;
      window.setTimeout(() => {
        if (shared.listeners.has(listener)) listener(cached);
      }, 0);
    }
    subscriptions.set(subscriptionId, () => {
      const current = sharedSubscriptions.get(key);
      if (!current) return;
      current.listeners.delete(listener);
      current.refs -= 1;
      if (current.refs > 0) return;
      sharedSubscriptions.delete(key);
      try {
        current.off();
      } catch {
        /* host subscription already gone */
      }
    });
  };

  const handle = async (message: GuestCall): Promise<void> => {
    const type = asString(message.type);
    const id = message.id;
    const payload = message.payload;
    try {
      switch (type) {
        case 'hello':
          sendReady();
          if (options.file) {
            post({ channel: CHANNEL, v: VERSION, type: 'file-open', payload: options.file });
          }
          return;
        case 'service-request': {
          reply(id, await options.serviceRequest(payload as GuestServiceRequest));
          return;
        }
        case 'service-status': {
          reply(id, await options.serviceStatus());
          return;
        }
        case 'storage': {
          reply(id, await options.storage(payload));
          return;
        }
        case 'toast':
          await options.host.toast(payload as Parameters<HostClient['toast']>[0]);
          reply(id, undefined);
          return;
        case 'open-url': {
          const url = asString((payload as { url?: unknown } | null)?.url);
          if (!url) throw new Error('missing url');
          await options.host.openUrl(url);
          reply(id, undefined);
          return;
        }
        case 'clipboard-write': {
          const text = asString((payload as { text?: unknown } | null)?.text);
          await options.host.writeClipboard(text);
          reply(id, undefined);
          return;
        }
        case 'compose':
          await options.host.compose(payload as Parameters<HostClient['compose']>[0]);
          reply(id, undefined);
          return;
        case 'attach':
          await options.host.attach(payload as Parameters<HostClient['attach']>[0]);
          reply(id, undefined);
          return;
        case 'prompt':
          reply(id, await options.host.prompt(payload as Parameters<HostClient['prompt']>[0]));
          return;
        case 'start-session':
          reply(
            id,
            await options.host.startSession(payload as Parameters<HostClient['startSession']>[0]),
          );
          return;
        case 'open-session': {
          const sessionId = asString((payload as { sessionId?: unknown } | null)?.sessionId);
          if (!sessionId) throw new Error('missing sessionId');
          await options.host.openSession(sessionId);
          reply(id, undefined);
          return;
        }
        case 'file-read':
        case 'file-list':
        case 'file-stat': {
          const path = asString((payload as { path?: unknown } | null)?.path);
          if (!path) throw new Error('missing path');
          if (type === 'file-read') reply(id, await options.host.readFile(path));
          else if (type === 'file-list') reply(id, await options.host.listDir(path));
          else reply(id, await options.host.stat(path));
          return;
        }
        case 'file-write': {
          const body = payload as { path?: unknown; content?: unknown } | null;
          reply(id, await options.host.writeFile(asString(body?.path), asString(body?.content)));
          return;
        }
        case 'badge': {
          const count = (payload as { count?: unknown } | null)?.count;
          await options.host.setBadge(typeof count === 'number' ? count : null);
          reply(id, undefined);
          return;
        }
        case 'workspace-read': {
          const query = payload as GuestWorkspaceQuery | null;
          if (query?.kind === 'projects') reply(id, await options.host.listProjects());
          else if (query?.kind === 'worktrees')
            reply(id, await options.host.listWorktrees(asString(query.projectId)));
          else if (query?.kind === 'sessions')
            reply(id, await options.host.listSessions(asString(query.projectId)));
          else throw new Error('missing workspace query');
          return;
        }
        case 'workspace-subscribe': {
          const sub = payload as { subscriptionId?: unknown; query?: GuestWorkspaceQuery } | null;
          const subscriptionId = asString(sub?.subscriptionId);
          const query = sub?.query;
          if (!subscriptionId || !query) throw new Error('missing workspace subscription');
          const push = (snapshot: unknown): void => {
            post({
              channel: CHANNEL,
              v: VERSION,
              type: 'workspace',
              payload: { subscriptionId, snapshot },
            });
          };
          if (query.kind === 'projects') {
            await subscribeShared('projects', subscriptionId, (cb) => options.host.onProjects(cb), push);
          } else if (query.kind === 'worktrees') {
            await subscribeShared(
              `worktrees:${query.projectId}`,
              subscriptionId,
              (cb) => options.host.onWorktrees(query.projectId, cb),
              push,
            );
          } else {
            await subscribeShared(
              `sessions:${query.projectId}`,
              subscriptionId,
              (cb) => options.host.onSessions(query.projectId, cb),
              push,
            );
          }
          reply(id, undefined);
          return;
        }
        case 'workspace-unsubscribe':
        case 'shells-unsubscribe': {
          const subscriptionId = asString(
            (payload as { subscriptionId?: unknown } | null)?.subscriptionId,
          );
          subscriptions.get(subscriptionId)?.();
          subscriptions.delete(subscriptionId);
          reply(id, undefined);
          return;
        }
        case 'shells-subscribe': {
          const sub = payload as { subscriptionId?: unknown; scope?: GuestShellsScope } | null;
          const subscriptionId = asString(sub?.subscriptionId);
          const scope = sub?.scope;
          if (!subscriptionId || !scope) throw new Error('missing shells subscription');
          await subscribeShared(
            `shells:${JSON.stringify(scope)}`,
            subscriptionId,
            (cb) => options.host.onRunningShells(scope, cb),
            (snapshot) =>
              post({
                channel: CHANNEL,
                v: VERSION,
                type: 'shells',
                payload: { subscriptionId, snapshot },
              }),
          );
          reply(id, undefined);
          return;
        }
        case 'shell-output': {
          const body = payload as {
            shellId?: unknown;
            cursor?: unknown;
            tailBytes?: unknown;
          } | null;
          const shellId = asString(body?.shellId);
          if (!shellId) throw new Error('missing shellId');
          reply(
            id,
            await options.host.readShellOutput(shellId, {
              ...(typeof body?.cursor === 'number' ? { cursor: body.cursor } : {}),
              ...(typeof body?.tailBytes === 'number' ? { tailBytes: body.tailBytes } : {}),
            }),
          );
          return;
        }
        case 'shell-stop': {
          const shellId = asString((payload as { shellId?: unknown } | null)?.shellId);
          if (!shellId) throw new Error('missing shellId');
          reply(id, await options.host.stopShell(shellId));
          return;
        }
        case 'generate-late-listen':
          options.onLateGenerateListen?.();
          return;
        case 'generate':
          reply(id, await options.host.generate(payload as GenerateRequest));
          return;
        case 'request':
          reply(id, await options.host.request(payload as GuestRequest));
          return;
        case 'session-link':
          await options.host.sessionLink(payload as AttachIssueRequest);
          reply(id, undefined);
          return;
        case 'open-commit': {
          const sha = asString((payload as { sha?: unknown } | null)?.sha);
          if (!sha) throw new Error('missing sha');
          await options.host.openCommit(sha);
          reply(id, undefined);
          return;
        }
        case 'open-surface': {
          const surfaceId = asString((payload as { surfaceId?: unknown } | null)?.surfaceId);
          if (!surfaceId) throw new Error('missing surfaceId');
          if (options.openSurface) await options.openSurface(surfaceId);
          else await options.host.openSurface(surfaceId);
          reply(id, undefined);
          return;
        }
        case 'oauth-start':
          await options.host.oauthStart();
          reply(id, undefined);
          return;
        case 'oauth-disconnect':
          await options.host.oauthDisconnect();
          reply(id, undefined);
          return;
        case 'status-controls': {
          const controls = (payload as { controls?: unknown } | null)?.controls;
          await options.host.setStatusControls(
            controls as Parameters<HostClient['setStatusControls']>[0],
          );
          reply(id, undefined);
          return;
        }
        case 'popover-close':
        case 'popover-anchor':
          reply(id, undefined);
          return;
        case 'popover-open':
          fail(id, 'UNSUPPORTED', '嵌入面板暂不支持宿主弹出层，请使用面板内交互');
          return;
        case 'resize':
          reply(id, undefined);
          return;
        case 'close':
          reply(id, undefined);
          window.setTimeout(options.close, 40);
          return;
        case 'file-change':
        case 'file-save':
        case 'file-unsupported':
          return;
        default:
          fail(id, 'UNSUPPORTED', `嵌入的扩展调用了尚未桥接的宿主能力：${type || 'unknown'}`);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      fail(id, 'SERVICE_FAILED', text);
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    if (event.source !== options.frame.contentWindow) return;
    const data = event.data as GuestCall | null;
    if (!data || typeof data !== 'object') return;
    if (data.channel !== CHANNEL) return;
    if (data.v !== VERSION) return;
    void handle(data);
  };

  const onLoad = (): void => {
    sendReady();
  };

  window.addEventListener('message', onMessage);
  options.frame.addEventListener('load', onLoad);

  return {
    sendReady,
    sendSession(session: unknown): void {
      post({ channel: CHANNEL, v: VERSION, type: 'session', payload: { session } });
    },
    sendSessionLifecycle(event: SessionLifecycleEvent): void {
      post({ channel: CHANNEL, v: VERSION, type: 'session-lifecycle', payload: event });
    },
    sendDirectory(directory: string | null): void {
      post({ channel: CHANNEL, v: VERSION, type: 'directory', payload: { directory } });
    },
    sendConnection(connection: GuestConnection): void {
      post({ channel: CHANNEL, v: VERSION, type: 'connection', payload: { connection } });
    },
    sendSettings(settings: GuestSettings): void {
      post({ channel: CHANNEL, v: VERSION, type: 'settings', payload: { settings } });
    },
    sendItem(item: GuestItem | null): void {
      post({ channel: CHANNEL, v: VERSION, type: 'item', payload: { item } });
    },
    sendGenerateLate(result: unknown): void {
      post({ channel: CHANNEL, v: VERSION, type: 'generate-late', payload: result });
    },
    dispose(): void {
      disposed = true;
      for (const off of subscriptions.values()) {
        try {
          off();
        } catch {
          /* subscriber already gone */
        }
      }
      subscriptions.clear();
      window.removeEventListener('message', onMessage);
      options.frame.removeEventListener('load', onLoad);
    },
  };
}
