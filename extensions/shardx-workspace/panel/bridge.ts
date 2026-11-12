import { CdpMultiplexer, CdpError, enableCdpDomains } from './cdp';
import type { CdpStartResult, Profile, TargetInfo } from './types';
import { ShardXApiClient, ApiError } from './api';
import { SessionIsolationRouter, SessionIsolationError } from './router';
import type { SessionSandbox } from './router';

type JsonRecord = Record<string, any>;

function ok(data: JsonRecord): string {
  return JSON.stringify({ ok: true, ...data }, null, 2);
}

function fail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof ApiError || error instanceof SessionIsolationError || error instanceof CdpError
      ? (error as any).code ?? null
      : null;
  return JSON.stringify({ ok: false, error: message, code }, null, 2);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

const EXTRACT_SCRIPT = `(function(selector, mode){
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: 'selector not found: ' + selector };
  const limit = 200000;
  const clip = (text) => text.length > limit ? text.slice(0, limit) + '\\n…[truncated]' : text;

  if (mode === 'html') return { html: clip(root.outerHTML) };
  if (mode === 'text') return { text: clip(root.innerText || root.textContent || '') };

  if (mode === 'forms') {
    const items = [];
    root.querySelectorAll('input,textarea,select,button,form').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const item = {
        tag,
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        value: tag === 'select' ? (el.value || '') : (el.getAttribute('value') || ''),
        text: tag === 'button' ? (el.innerText || '').trim().slice(0, 120) : '',
        required: el.hasAttribute('required'),
        disabled: el.hasAttribute('disabled'),
        options: tag === 'select' ? Array.from(el.options).map(o => ({ value: o.value, text: o.text })) : undefined
      };
      if (tag === 'form') {
        item.action = el.getAttribute('action') || '';
        item.method = (el.getAttribute('method') || 'get').toUpperCase();
      }
      items.push(item);
    });
    return { forms: items };
  }

  const blocks = [];
  const seen = new Set();
  const push = (text, prefix) => {
    const clean = (text || '').replace(/\\s+/g, ' ').trim();
    if (!clean) return;
    const key = prefix + clean;
    if (seen.has(key)) return;
    seen.add(key);
    blocks.push(prefix + clean);
  };
  const walk = (node) => {
    if (node.nodeType === 3) return;
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (['script','style','noscript','template','svg','iframe','canvas'].includes(tag)) return;
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return;
    if (tag.match(/^h[1-6]$/)) {
      push(node.innerText || '', '#'.repeat(Number(tag[1])) + ' ');
      return;
    }
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      const label = (node.innerText || '').replace(/\\s+/g, ' ').trim();
      if (label) blocks.push('[' + label + '](' + href + ')');
      return;
    }
    if (tag === 'img') {
      const alt = node.getAttribute('alt') || '';
      const src = node.getAttribute('src') || '';
      if (src) blocks.push('![' + alt + '](' + src + ')');
      return;
    }
    if (tag === 'li') {
      push(node.innerText || '', '- ');
      return;
    }
    if (tag === 'p' || tag === 'blockquote' || tag === 'pre' || tag === 'td' || tag === 'th' || tag === 'label' || tag === 'button') {
      push(node.innerText || '', '');
      return;
    }
    if (tag === 'br') {
      blocks.push('');
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  const markdown = blocks.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { markdown: clip(markdown), title: document.title, url: location.href };
})`;

const FOCUS_SCRIPT = `(function(selector){
  const el = document.querySelector(selector);
  if (!el) return { error: 'selector not found: ' + selector };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof el.focus === 'function') el.focus();
  const rect = el.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || '').slice(0, 200)
  };
})`;

const KEY_CODES: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

export class OpenChamberBridge {
  private defaultSessionId: string;
  private api: ShardXApiClient;
  private router: SessionIsolationRouter;

  constructor(sessionId: string, api: ShardXApiClient, router: SessionIsolationRouter) {
    this.defaultSessionId = sessionId;
    this.api = api;
    this.router = router;
  }

  setDefaultSessionId(sessionId: string): void {
    if (sessionId) this.defaultSessionId = sessionId;
  }

  private sessionId(explicit?: string): string {
    return explicit && explicit.trim() ? explicit.trim() : this.defaultSessionId;
  }

  /**
   * Bind a free profile to a session and launch it with CDP.
   * Used by the panel as well as by external tooling; idempotent for the same
   * session/profile pair.
   */
  async startSessionProfile(sessionId: string, profileId: string, profileName = ''): Promise<SessionSandbox> {
    const owner = this.router.owner(profileId);
    if (owner && owner !== sessionId) {
      throw new SessionIsolationError(
        `profile ${profileId} 已被会话 ${owner} 独占`,
        'PROFILE_LOCKED',
      );
    }

    const existing = this.router.getByProfile(profileId);
    if (
      existing &&
      existing.sessionId === sessionId &&
      existing.status === 'running' &&
      existing.cdp?.isOpen()
    ) {
      return existing;
    }

    this.router.bindSession(sessionId, profileId, profileName);
    try {
      const started: CdpStartResult = await this.api.startProfile(profileId);
      const cdp = new CdpMultiplexer(profileId);
      await cdp.connect(started.cdpWebSocketDebuggerUrl, 15000, this.api.authHeaders());
      await enableCdpDomains(cdp);
      const sandbox = this.router.attachCdp(profileId, started.cdpWebSocketDebuggerUrl, cdp);
      return sandbox;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.router.markError(profileId, message);
      this.router.unbindProfile(profileId);
      throw error;
    }
  }

  /**
   * Attach to a profile that ShardX already launched (for example from the
   * launcher's own window) without starting or restarting it. The sandbox is
   * created lazily through `bindSession`, so a stale binding is cleaned first.
   */
  async attachRunningProfile(
    sessionId: string,
    profileId: string,
    profileName = '',
    cdpWebSocketDebuggerUrl = '',
  ): Promise<SessionSandbox> {
    const owner = this.router.owner(profileId);
    if (owner && owner !== sessionId) {
      throw new SessionIsolationError(
        `profile ${profileId} 已被会话 ${owner} 独占`,
        'PROFILE_LOCKED',
      );
    }
    const existing = this.router.getByProfile(profileId);
    if (
      existing &&
      existing.sessionId === sessionId &&
      existing.status === 'running' &&
      existing.cdp?.isOpen()
    ) {
      return existing;
    }
    let wsUrl = cdpWebSocketDebuggerUrl.trim();
    if (!wsUrl) {
      const list = await this.api.running();
      const hit = list.find((item) => item.profileId === profileId);
      wsUrl = hit?.cdpWebSocketDebuggerUrl ?? '';
    }
    if (!wsUrl) {
      throw new CdpError(`profile ${profileId} 没有可用的 CDP 地址`, 0, 'NO_CDP');
    }

    if (existing) this.router.unbindProfile(profileId);
    this.router.bindSession(sessionId, profileId, profileName || profileId);
    try {
      const cdp = new CdpMultiplexer(profileId);
      await cdp.connect(wsUrl, 15000, this.api.authHeaders());
      await enableCdpDomains(cdp);
      return this.router.attachCdp(profileId, wsUrl, cdp);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.router.markError(profileId, message);
      this.router.unbindProfile(profileId);
      throw error;
    }
  }

  async releaseProfile(profileId: string): Promise<void> {
    const sandbox = this.router.getByProfile(profileId);
    if (!sandbox) {
      try {
        await this.api.stopProfile(profileId);
      } catch {
        /* profile already stopped */
      }
      return;
    }
    this.router.unbindProfile(profileId);
    try {
      await this.api.stopProfile(profileId);
    } catch (error) {
      console.warn('[ShardX] 停止 profile 失败', profileId, error);
    }
  }

  /** Stop every browser owned by a session (used by session-scoped callers). */
  async releaseSession(sessionId: string): Promise<string[]> {
    const released: string[] = [];
    for (const sandbox of this.router.allForSession(sessionId)) {
      released.push(sandbox.profileId);
      await this.releaseProfile(sandbox.profileId);
    }
    return released;
  }

  async resolvePage(sandbox: SessionSandbox): Promise<{
    targetId: string | null;
    cdpSessionId: string | null;
    targets: TargetInfo[];
  }> {
    const cdp = sandbox.cdp;
    if (!cdp) throw new CdpError('会话未连接 CDP');

    let targets: TargetInfo[] = [];
    try {
      const raw = await cdp.send<{ targetInfos?: TargetInfo[] }>('Target.getTargets', {}, null, 8000);
      targets = raw.targetInfos ?? [];
    } catch {
      // Page-level websocket: no Target domain, use it directly.
      return { targetId: null, cdpSessionId: null, targets: [] };
    }

    const pages = targets.filter((target) => target.type === 'page');
    if (pages.length === 0) {
      return { targetId: null, cdpSessionId: null, targets };
    }
    const preferred =
      (sandbox.activeTargetId && pages.find((page) => page.targetId === sandbox.activeTargetId)) ||
      pages.find((page) => page.url && page.url !== 'about:blank') ||
      pages[0];

    let cdpSessionId = sandbox.activeCdpSessionId;
    if (sandbox.activeTargetId !== preferred.targetId || !cdpSessionId) {
      try {
        const attached = await cdp.send<{ sessionId?: string }>(
          'Target.attachToTarget',
          { targetId: preferred.targetId, flatten: true },
          null,
          8000,
        );
        cdpSessionId = attached.sessionId ?? null;
      } catch {
        cdpSessionId = null;
      }
      this.router.patch(sandbox.profileId, {
        targets,
        activeTargetId: preferred.targetId,
        activeCdpSessionId: cdpSessionId,
      });
    } else {
      this.router.patch(sandbox.profileId, { targets });
    }

    if (cdpSessionId) {
      await enableCdpDomains(cdp, cdpSessionId);
    }
    return { targetId: preferred.targetId, cdpSessionId, targets };
  }

  private requireSandbox(sessionId: string, profileId?: string): SessionSandbox {
    let sandbox: SessionSandbox | null = null;
    if (profileId) {
      sandbox = this.router.getByProfile(profileId);
      if (!sandbox) {
        throw new SessionIsolationError(
          `profile ${profileId} 还没有在当前工作台启动，先调用 shardx_list_and_bind_profile`,
          'NOT_BOUND',
        );
      }
      if (sandbox.sessionId !== sessionId) {
        throw new SessionIsolationError(
          `profile ${profileId} 属于会话 ${sandbox.sessionId}，请用该会话或先接管映射`,
          'PROFILE_LOCKED',
        );
      }
    } else {
      const owned = this.router.allForSession(sessionId);
      if (owned.length > 1) {
        throw new SessionIsolationError(
          `会话 ${sessionId} 有多个实例，请传 profile_id：${owned
            .map((item) => `${item.profileName}(${item.profileId})`)
            .join('、')}`,
          'AMBIGUOUS_PROFILE',
        );
      }
      sandbox = owned[0] ?? null;
    }
    if (!sandbox) {
      throw new SessionIsolationError(
        `会话 ${sessionId} 还没有绑定指纹环境，先调用 shardx_list_and_bind_profile`,
        'NOT_BOUND',
      );
    }
    if (!sandbox.cdp || !sandbox.cdp.isOpen()) {
      throw new CdpError('CDP 未连接，请重新启动实例', 0);
    }
    return sandbox;
  }

  // ---------------------------------------------------------------------
  // Agent tool: shardx_list_and_bind_profile
  // ---------------------------------------------------------------------
  async listAndBindProfile(
    sessionId: string,
    action: 'list' | 'bind' | 'auto-bind',
    profileId?: string,
    folder?: string,
  ): Promise<string> {
    const sid = this.sessionId(sessionId);
    try {
      const profiles = await this.api.profiles(folder);
      if (action === 'list') {
        return ok({
          action: 'list',
          total: profiles.length,
          running: profiles.filter((p) => isRunning(p)).length,
          bound: this.router.bindings().filter((binding) => binding.sessionId === sid),
          profiles: profiles.map((profile) => this.describeProfile(profile)),
        });
      }

      let target: Profile | undefined;
      if (action === 'auto-bind') {
        target = profiles.find((profile) => !this.router.owner(profile.id));
      } else {
        target = profiles.find((profile) => profile.id === profileId);
        if (!target && profileId) target = await this.api.profile(profileId);
      }
      if (!target) {
        return fail(
          new SessionIsolationError(
            action === 'auto-bind' ? '没有空闲的指纹环境可绑定' : `找不到 profile: ${profileId}`,
            'PROFILE_NOT_FOUND',
          ),
        );
      }

      const sandbox = await this.startSessionProfile(sid, target.id, target.name || target.id);
      return ok({
        action,
        session_id: sid,
        profile: this.describeProfile(target),
        sandbox: {
          status: sandbox.status,
          cdp_ws_url: sandbox.cdpWsUrl,
          bound_profiles: [...this.router.lockedProfiles.entries()].map(([profile, session]) => ({
            profile,
            session,
          })),
        },
      });
    } catch (error) {
      return fail(error);
    }
  }

  // ---------------------------------------------------------------------
  // Agent tool: shardx_session_navigate
  // ---------------------------------------------------------------------
  async navigate(sessionId: string, url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'networkidle', profileId?: string): Promise<string> {
    const sid = this.sessionId(sessionId);
    try {
      const sandbox = this.requireSandbox(sid, profileId);
      const page = await this.resolvePage(sandbox);
      const cdp = sandbox.cdp as CdpMultiplexer;

      const loadedEvent = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
      const settled = cdp
        .waitEvent(
          loadedEvent,
          (params, eventSession) => !page.cdpSessionId || eventSession === page.cdpSessionId,
          Math.max(15000, 0),
        )
        .catch(() => null);

      const result = await cdp.send<{ frameId?: string; errorText?: string }>(
        'Page.navigate',
        { url },
        page.cdpSessionId,
      );
      if (result.errorText) throw new CdpError(`导航失败: ${result.errorText}`);

      const event = await Promise.race([
        settled,
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 15000)),
      ]);
      if (waitUntil === 'networkidle') {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
      }

      let title = '';
      try {
        const evaluated = await cdp.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: 'document.title', returnByValue: true },
          page.cdpSessionId,
        );
        title = String(evaluated.result?.value ?? '');
      } catch {
        title = '';
      }

      return ok({
        session_id: sid,
        url,
        title,
        frame_id: result.frameId ?? null,
        load_event: event ? loadedEvent : 'timeout',
      });
    } catch (error) {
      return fail(error);
    }
  }

  // ---------------------------------------------------------------------
  // Agent tool: shardx_session_interact
  // ---------------------------------------------------------------------
  async interact(
    sessionId: string,
    action: 'click' | 'type' | 'scroll' | 'evaluate_js',
    options: { selector?: string; text?: string; x?: number; y?: number; script?: string; dy?: number } = {},
    profileId?: string,
  ): Promise<string> {
    const sid = this.sessionId(sessionId);
    try {
      const sandbox = this.requireSandbox(sid, profileId);
      const page = await this.resolvePage(sandbox);
      const cdp = sandbox.cdp as CdpMultiplexer;

      if (action === 'evaluate_js') {
        if (!options.script) throw new CdpError('evaluate_js 需要 script 参数');
        const evaluated = await cdp.send<{ result?: any; exceptionDetails?: any }>(
          'Runtime.evaluate',
          {
            expression: options.script,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
          page.cdpSessionId,
        );
        if (evaluated.exceptionDetails) {
          return fail(new CdpError('页面脚本异常: ' + JSON.stringify(evaluated.exceptionDetails)));
        }
        return ok({ action, value: evaluated.result?.value ?? null });
      }

      if (action === 'click') {
        let x = options.x;
        let y = options.y;
        let targetInfo: JsonRecord = { x, y };
        if (options.selector) {
          const box = await cdp.send<{ result?: { value?: JsonRecord } }>(
            'Runtime.evaluate',
            {
              expression: `${FOCUS_SCRIPT}(${quote(options.selector)})`,
              returnByValue: true,
              awaitPromise: true,
            },
            page.cdpSessionId,
          );
          targetInfo = box.result?.value ?? {};
          if (targetInfo.error) throw new CdpError(String(targetInfo.error));
          x = Number(targetInfo.x);
          y = Number(targetInfo.y);
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new CdpError('click 需要 selector 或 x/y 坐标');
        }
        const point = { x: Number(x), y: Number(y), button: 'left', clickCount: 1 };
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, page.cdpSessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point }, page.cdpSessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point }, page.cdpSessionId);
        return ok({ action, clicked: targetInfo, x: point.x, y: point.y });
      }

      if (action === 'type') {
        if (!options.text) throw new CdpError('type 需要 text 参数');
        if (options.selector) {
          const focused = await cdp.send<{ result?: { value?: JsonRecord } }>(
            'Runtime.evaluate',
            {
              expression: `${FOCUS_SCRIPT}(${quote(options.selector)})`,
              returnByValue: true,
            },
            page.cdpSessionId,
          );
          if (focused.result?.value?.error) throw new CdpError(String(focused.result.value.error));
        }
        await cdp.send('Input.insertText', { text: options.text }, page.cdpSessionId);
        if (options.selector) {
          await cdp.send(
            'Runtime.evaluate',
            {
              expression: `(()=>{const el=document.querySelector(${quote(options.selector)}); if(!el) return null; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value ?? null;})()`,
              returnByValue: true,
            },
            page.cdpSessionId,
          );
        }
        return ok({ action, typed: options.text.length, selector: options.selector ?? null });
      }

      if (action === 'scroll') {
        const dy = Number.isFinite(options.dy) ? Number(options.dy) : 600;
        if (options.selector) {
          await cdp.send(
            'Runtime.evaluate',
            {
              expression: `(()=>{const el=document.querySelector(${quote(options.selector)}); if(!el) return false; el.scrollIntoView({block:'center'}); return true;})()`,
              returnByValue: true,
            },
            page.cdpSessionId,
          );
          return ok({ action, scrolled_to: options.selector });
        }
        const result = await cdp.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          {
            expression: `(()=>{const before=window.scrollY; window.scrollBy(0,${dy}); return {before, after: window.scrollY};})()`,
            returnByValue: true,
          },
          page.cdpSessionId,
        );
        return ok({ action, scrolled: result.result?.value ?? null });
      }

      throw new CdpError(`不支持的交互类型: ${action}`);
    } catch (error) {
      return fail(error);
    }
  }

  // ---------------------------------------------------------------------
  // Agent tool: shardx_session_extract_dom
  // ---------------------------------------------------------------------
  async extractDom(
    sessionId: string,
    selector?: string,
    mode: 'markdown' | 'html' | 'forms' | 'text' = 'markdown',
    profileId?: string,
  ): Promise<string> {
    const sid = this.sessionId(sessionId);
    try {
      const sandbox = this.requireSandbox(sid, profileId);
      const page = await this.resolvePage(sandbox);
      const cdp = sandbox.cdp as CdpMultiplexer;
      const expression = `${EXTRACT_SCRIPT}(${quote(selector ?? '')}, ${quote(mode)})`;
      const evaluated = await cdp.send<{ result?: { value?: JsonRecord }; exceptionDetails?: any }>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        page.cdpSessionId,
        30000,
      );
      if (evaluated.exceptionDetails) {
        return fail(new CdpError('提取脚本异常: ' + JSON.stringify(evaluated.exceptionDetails)));
      }
      const value = evaluated.result?.value ?? {};
      if (value.error) throw new CdpError(String(value.error));
      return ok({ session_id: sid, mode, selector: selector ?? null, ...value });
    } catch (error) {
      return fail(error);
    }
  }

  // ---------------------------------------------------------------------
  // Agent tool: shardx_session_manage_cookies
  // ---------------------------------------------------------------------
  async manageCookies(
    sessionId: string,
    action: 'get' | 'set' | 'clear',
    cookiesJson?: string,
    profileId?: string,
  ): Promise<string> {
    const sid = this.sessionId(sessionId);
    try {
      const sandbox = this.requireSandbox(sid, profileId);
      const page = await this.resolvePage(sandbox);
      const cdp = sandbox.cdp as CdpMultiplexer;

      const call = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        try {
          return await cdp.send<T>(method, params, null, 20000);
        } catch (error) {
          if (!page.cdpSessionId) throw error;
          return await cdp.send<T>(method, params, page.cdpSessionId, 20000);
        }
      };

      if (action === 'get') {
        const result = await call<{ cookies?: JsonRecord[] }>('Storage.getCookies');
        const cookies = result.cookies ?? [];
        return ok({ action, count: cookies.length, cookies });
      }

      if (action === 'clear') {
        await call('Storage.clearCookies');
        return ok({ action, cleared: true });
      }

      if (!cookiesJson) throw new CdpError('set 需要 cookies_json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(cookiesJson);
      } catch (error) {
        throw new CdpError('cookies_json 不是合法 JSON: ' + String(error));
      }
      const cookies = Array.isArray(parsed) ? parsed : [parsed];
      if (cookies.length === 0) throw new CdpError('cookies_json 为空');
      try {
        await call('Storage.setCookies', { cookies });
      } catch {
        for (const cookie of cookies as JsonRecord[]) {
          await call('Network.setCookie', cookie);
        }
      }
      return ok({ action, injected: cookies.length });
    } catch (error) {
      return fail(error);
    }
  }

  // ---------------------------------------------------------------------
  // Skill runner (panel side)
  // ---------------------------------------------------------------------
  async runSkill(
    profileId: string,
    steps: Array<Record<string, any>>,
  ): Promise<{ profile_id: string; steps: Array<Record<string, any>> }> {
    const sandbox = this.router.getByProfile(profileId);
    if (!sandbox || !sandbox.cdp || !sandbox.cdp.isOpen()) {
      throw new CdpError(`profile ${profileId} 未在运行，无法执行 Skill`);
    }
    const cdp = sandbox.cdp as CdpMultiplexer;
    const page = await this.resolvePage(sandbox);
    const sid = page.cdpSessionId;
    const results: Array<Record<string, any>> = [];

    const evaluate = async (expression: string): Promise<unknown> => {
      const response = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: any }>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true, userGesture: true },
        sid,
        30000,
      );
      if (response.exceptionDetails) {
        throw new CdpError(
          '页面脚本异常: ' +
            String(
              response.exceptionDetails.exception?.description ??
                response.exceptionDetails.text ??
                'unknown',
            ),
        );
      }
      return response.result?.value ?? null;
    };

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index] ?? {};
      const action = String(step.action ?? '').trim();
      const record: Record<string, any> = { index, action };
      try {
        if (action === 'navigate') {
          const url = String(step.url ?? '').trim();
          if (!url) throw new CdpError('navigate 缺少 url');
          const loaded = cdp
            .waitEvent('Page.loadEventFired', (_params, eventSession) => !sid || eventSession === sid, 20000)
            .catch(() => null);
          const nav = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, sid);
          if (nav.errorText) throw new CdpError(`导航失败: ${nav.errorText}`);
          await loaded;
          record.result = { url };
        } else if (action === 'reload') {
          await cdp.send('Page.reload', {}, sid);
          await new Promise((resolve) => window.setTimeout(resolve, 900));
          record.result = 'reloaded';
        } else if (action === 'wait') {
          const ms = Math.max(0, Number(step.ms ?? 800));
          if (step.selector) {
            const deadline = Date.now() + Math.max(ms, 1000);
            let found = false;
            while (Date.now() < deadline) {
              found = Boolean(await evaluate(`!!document.querySelector(${quote(String(step.selector))})`));
              if (found) break;
              await new Promise((resolve) => window.setTimeout(resolve, 250));
            }
            if (!found) throw new CdpError(`等待元素超时: ${step.selector}`);
            record.result = { selector: step.selector, found };
          } else {
            await new Promise((resolve) => window.setTimeout(resolve, ms));
            record.result = { waited_ms: ms };
          }
        } else if (action === 'click') {
          let x = Number(step.x);
          let y = Number(step.y);
          if (step.selector) {
            const box = await evaluate(`${FOCUS_SCRIPT}(${quote(String(step.selector))})`);
            const rect = box as Record<string, any>;
            if (rect?.error) throw new CdpError(String(rect.error));
            x = Number(rect?.x);
            y = Number(rect?.y);
          }
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CdpError('click 需要 selector 或 x/y');
          const point = { x, y, button: 'left', clickCount: 1 };
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point }, sid);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point }, sid);
          record.result = { x, y };
        } else if (action === 'type') {
          const text = String(step.text ?? '');
          if (step.selector) {
            const focused = await evaluate(`${FOCUS_SCRIPT}(${quote(String(step.selector))})`);
            if ((focused as Record<string, any>)?.error) {
              throw new CdpError(String((focused as Record<string, any>).error));
            }
            await cdp.send('Input.insertText', { text }, sid);
            await evaluate(
              `(()=>{const el=document.querySelector(${quote(String(step.selector))}); if(!el) return null; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value ?? null;})()`,
            );
          } else {
            await cdp.send('Input.insertText', { text }, sid);
          }
          record.result = { typed: text.length };
        } else if (action === 'evaluate') {
          const script = String(step.script ?? '').trim();
          if (!script) throw new CdpError('evaluate 缺少 script');
          record.result = await evaluate(script);
        } else if (action === 'extract') {
          const selector = step.selector ? String(step.selector) : '';
          const mode = String(step.mode ?? 'text');
          const expression =
            mode === 'html'
              ? `(()=>{const el=${selector ? `document.querySelector(${quote(selector)})` : 'document.body'};return el?el.outerHTML:'';})()`
              : `(()=>{const el=${selector ? `document.querySelector(${quote(selector)})` : 'document.body'};return el?el.innerText:'';})()`;
          const value = await evaluate(expression);
          record.result = String(value ?? '').slice(0, 4000);
        } else {
          throw new CdpError(`不支持的 Skill 步骤: ${action || '(空)'}`);
        }
        record.ok = true;
      } catch (error) {
        record.ok = false;
        record.error = error instanceof Error ? error.message : String(error);
        results.push(record);
        break;
      }
      results.push(record);
    }
    return { profile_id: profileId, steps: results };
  }

  // ---------------------------------------------------------------------
  // Agent tool: shardx_session_stop_and_release
  // ---------------------------------------------------------------------
  async stopAndRelease(sessionId: string, profileId?: string): Promise<string> {
    const sid = this.sessionId(sessionId);
    try {
      if (profileId) {
        const sandbox = this.router.getByProfile(profileId);
        if (!sandbox) return ok({ session_id: sid, released: false, reason: 'profile 未在会话中运行' });
        await this.releaseProfile(profileId);
        return ok({ session_id: sid, released: true, profile_id: profileId });
      }
      const owned = this.router.allForSession(sid);
      if (owned.length === 0) return ok({ session_id: sid, released: false, reason: '会话未绑定任何 profile' });
      if (owned.length > 1) {
        return fail(
          new SessionIsolationError(
            `会话 ${sid} 有多个实例，请传 profile_id：${owned.map((item) => item.profileId).join('、')}`,
            'AMBIGUOUS_PROFILE',
          ),
        );
      }
      const only = owned[0];
      await this.releaseProfile(only.profileId);
      return ok({ session_id: sid, released: true, profile_id: only.profileId });
    } catch (error) {
      return fail(error);
    }
  }

  // ---------------------------------------------------------------------
  // Dispatcher for external tool calls
  // ---------------------------------------------------------------------
  async handleToolCall(name: string, args: JsonRecord): Promise<string> {
    const sessionId = this.sessionId(args.session_id);
    switch (name) {
      case 'shardx_list_and_bind_profile':
        return this.listAndBindProfile(sessionId, args.action ?? 'list', args.profile_id, args.folder);
      case 'shardx_session_navigate':
        return this.navigate(sessionId, args.url, args.wait_until ?? 'networkidle', args.profile_id);
      case 'shardx_session_interact':
        return this.interact(
          sessionId,
          args.action,
          {
            selector: args.selector,
            text: args.text,
            x: args.x,
            y: args.y,
            script: args.script,
            dy: args.dy,
          },
          args.profile_id,
        );
      case 'shardx_session_extract_dom':
        return this.extractDom(sessionId, args.selector, args.mode ?? 'markdown', args.profile_id);
      case 'shardx_session_manage_cookies':
        return this.manageCookies(sessionId, args.action, args.cookies_json, args.profile_id);
      case 'shardx_session_stop_and_release':
        return this.stopAndRelease(sessionId, args.profile_id);
      default:
        return fail(new Error(`未知工具: ${name}`));
    }
  }

  // ---------------------------------------------------------------------
  // Shared helpers used by the UI
  // ---------------------------------------------------------------------
  describeProfile(profile: Profile): JsonRecord {
    const fingerprint = (profile.fingerprint ?? {}) as JsonRecord;
    const os = (fingerprint.os ?? {}) as JsonRecord;
    const navigator = (fingerprint.navigator ?? {}) as JsonRecord;
    const noise = (fingerprint.noise ?? {}) as JsonRecord;
    return {
      id: profile.id,
      name: profile.name || profile.id,
      folder: profile.folder ?? '',
      status: isRunning(profile) ? 'running' : 'stopped',
      platform: os.name ?? os.platform ?? profile.platform ?? fingerprint.platform ?? '',
      kernel: os.kernel ?? os.version ?? '',
      cpu: navigator.hardware_concurrency ?? navigator.hardwareConcurrency ?? fingerprint.cpu_cores ?? null,
      memory: navigator.device_memory ?? navigator.deviceMemory ?? fingerprint.device_memory ?? null,
      timezone: fingerprint.timezone ?? fingerprint.time_zone ?? '',
      noise_seed: noise.seed ?? fingerprint.noise_seed ?? fingerprint.seed ?? null,
      proxy_id: profile.proxy_id ?? null,
      owner_session: this.router.owner(profile.id),
    };
  }

  async sendKeys(sessionId: string, keys: string, profileId?: string): Promise<void> {
    const sandbox = this.requireSandbox(sessionId, profileId);
    const page = await this.resolvePage(sandbox);
    const cdp = sandbox.cdp as CdpMultiplexer;
    if (keys.length === 1) {
      await cdp.send('Input.insertText', { text: keys }, page.cdpSessionId);
      return;
    }
    const spec = KEY_CODES[keys];
    if (!spec) {
      await cdp.send('Input.insertText', { text: keys }, page.cdpSessionId);
      return;
    }
    const base = {
      key: keys,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, page.cdpSessionId);
    if (spec.text) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: spec.text, ...base }, page.cdpSessionId);
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, page.cdpSessionId);
  }
}

export function isRunning(profile: Profile): boolean {
  const status = String(profile.status ?? '').toLowerCase();
  return status === 'running' || status === 'started' || (profile as any).running === true;
}
