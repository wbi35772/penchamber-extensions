/**
 * ShardX Workspace MCP server (stdio, zero dependencies).
 *
 * OpenChamber extensions cannot register agent tools by themselves: the
 * `contributes.tools` entry only styles tool calls in the chat. The callable
 * tools live here, spoken over MCP on stdin/stdout, and drive the local ShardX
 * launcher exactly like the panel does (REST + CDP).
 *
 * Requirements: Node >= 22 (global WebSocket), a running ShardX launcher with
 * the automation API enabled. The launcher is discovered through its own
 * `%APPDATA%\shardx-launcher\settings.json`; no path or token has to be typed.
 *
 * The panel and this server share `%APPDATA%\shardx-workspace\state.json`
 * (mappings, skills, assignments, launcher path). Override with
 * SHARDX_WORKSPACE_STATE / SHARDX_LAUNCHER_SETTINGS.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
const TOOLS = Array.isArray(CATALOG.tools) ? CATALOG.tools : [];
const SERVER = { name: 'shardx', version: CATALOG.version || '1.2.0' };

const API_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 90_000;
const CDP_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Launcher discovery + REST
// ---------------------------------------------------------------------------

let launcherCache = null;

function settingsPath() {
  const override = String(process.env.SHARDX_LAUNCHER_SETTINGS ?? '').trim();
  if (override) return override;
  const appData = String(process.env.APPDATA ?? '').trim();
  return appData ? `${appData}\\shardx-launcher\\settings.json` : '';
}

function loadLauncher() {
  const path = settingsPath();
  if (!path) throw new Error('APPDATA 不可用，无法定位 ShardX 配置');
  let settings;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`读取 ShardX 配置失败（${path}）：${error instanceof Error ? error.message : String(error)}`);
  }
  const port = Number(settings.api_port);
  const secret = String(settings.api_secret ?? '').trim();
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('ShardX 配置中没有有效的 api_port');
  if (!secret) throw new Error('ShardX 还没有生成 api_secret，请先在客户端开启自动化 API');
  return { port: Math.trunc(port), secret, dataRoot: String(settings.data_root ?? ''), path, raw: settings };
}

function launcher() {
  if (!launcherCache) launcherCache = loadLauncher();
  return launcherCache;
}

function mintToken(secret, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ sub: 'shardx-api', iat: now, exp: now + ttlSeconds })).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${header}.${claims}`).digest('base64url');
  return `${header}.${claims}.${signature}`;
}

const tokenCache = { token: '', expiresAt: 0 };

function bearer() {
  const { secret } = launcher();
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;
  tokenCache.token = mintToken(secret);
  tokenCache.expiresAt = now + 50 * 60 * 1000;
  return tokenCache.token;
}

async function api(method, path, { query, body, timeoutMs = API_TIMEOUT_MS, retried = false } = {}) {
  const { port } = launcher();
  const url = new URL(path, `http://127.0.0.1:${port}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
  }
  const headers = { Accept: 'application/json', Authorization: `Bearer ${bearer()}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`无法连接 ShardX（http://127.0.0.1:${port}）：${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (response.status === 401 && !retried) {
    launcherCache = null;
    tokenCache.token = '';
    return api(method, path, { query, body, timeoutMs, retried: true });
  }
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const detail = typeof parsed === 'object' && parsed
      ? parsed.error ?? parsed.message ?? parsed.detail ?? text
      : text;
    throw new Error(`ShardX ${method} ${path} -> ${response.status} ${String(detail).slice(0, 400)}`);
  }
  return parsed;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'data', 'list', 'profiles', 'folders', 'proxies', 'running']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Workspace state (shared with the panel through the bridge service)
// ---------------------------------------------------------------------------

function workspaceStatePath() {
  const override = String(process.env.SHARDX_WORKSPACE_STATE ?? '').trim();
  if (override) return override;
  const appData = String(process.env.APPDATA ?? '').trim();
  return appData
    ? join(appData, 'shardx-workspace', 'state.json')
    : join(HERE, 'workspace-state.json');
}

function normalizeSteps(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((step) => step && typeof step === 'object' && typeof step.action === 'string')
    .map((step) => ({ ...step }));
}

function normalizeSkill(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!id) return null;
  return {
    ...raw,
    id,
    name: String(raw.name ?? id),
    site: String(raw.site ?? ''),
    url_pattern: String(raw.url_pattern ?? ''),
    description: String(raw.description ?? ''),
    steps: normalizeSteps(raw.steps),
    created_at: Number(raw.created_at) || Date.now(),
    updated_at: Number(raw.updated_at) || Date.now(),
  };
}

function normalizeWorkspaceState(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const mappings = Array.isArray(base.mappings) ? base.mappings : [];
  const skills = Array.isArray(base.skills) ? base.skills : [];
  const assignments = Array.isArray(base.assignments) ? base.assignments : [];
  return {
    ...base,
    version: Number(base.version) || 1,
    mappings: mappings
      .filter((item) => item && typeof item === 'object' && item.profile_id)
      .map((item) => ({
        ...item,
        profile_id: String(item.profile_id),
        profile_name: String(item.profile_name ?? item.profile_id),
        session_id: String(item.session_id ?? ''),
        source: String(item.source ?? ''),
        updated_at: Number(item.updated_at) || Date.now(),
      })),
    skills: skills.map(normalizeSkill).filter(Boolean),
    assignments: assignments
      .filter((item) => item && typeof item === 'object' && item.skill_id && item.target_type && item.target_id)
      .map((item) => ({
        ...item,
        skill_id: String(item.skill_id),
        target_type: item.target_type === 'folder' ? 'folder' : 'profile',
        target_id: String(item.target_id),
        created_at: Number(item.created_at) || Date.now(),
      })),
    settings: {
      ...(base.settings && typeof base.settings === 'object' ? base.settings : {}),
      launcher_path: String(base.settings?.launcher_path ?? ''),
    },
  };
}

function readWorkspaceState() {
  try {
    return normalizeWorkspaceState(JSON.parse(readFileSync(workspaceStatePath(), 'utf8')));
  } catch {
    return normalizeWorkspaceState({});
  }
}

function writeWorkspaceState(state) {
  const file = workspaceStatePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
  return state;
}

function saveMapping(profileId, profileName, sessionId, source = 'mcp') {
  const state = readWorkspaceState();
  state.mappings = state.mappings.filter((item) => item.profile_id !== profileId);
  state.mappings.push({
    profile_id: profileId,
    profile_name: profileName || profileId,
    session_id: sessionId,
    source,
    updated_at: Date.now(),
  });
  return writeWorkspaceState(state);
}

function removeMapping(profileId, sessionId = '') {
  const state = readWorkspaceState();
  state.mappings = state.mappings.filter((item) => {
    if (item.profile_id !== profileId) return true;
    if (sessionId && item.session_id !== sessionId) return true;
    return false;
  });
  return writeWorkspaceState(state);
}

function skillsForProfile(state, profileId, folder = '') {
  const ids = new Set(
    state.assignments
      .filter(
        (item) =>
          (item.target_type === 'profile' && item.target_id === profileId) ||
          (item.target_type === 'folder' && folder && item.target_id === folder),
      )
      .map((item) => item.skill_id),
  );
  return state.skills.filter((skill) => ids.has(skill.id));
}

// ---------------------------------------------------------------------------
// Minimal CDP client (one socket per attached profile)
// ---------------------------------------------------------------------------

class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;
  #closeReason = '';

  static async open(url, timeoutMs = 15_000) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前 Node 运行时没有全局 WebSocket（需要 Node >= 22）');
    }
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(url);
    cdp.#ws.addEventListener('message', (event) => cdp.#dispatch(event.data));
    cdp.#ws.addEventListener('close', () => {
      cdp.#closed = cdp.#closed || true;
      cdp.#closeReason = 'CDP 连接已关闭';
      for (const pending of cdp.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(cdp.#closeReason));
      }
      cdp.#pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP 超时')), timeoutMs);
      cdp.#ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      cdp.#ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('连接 CDP 失败'));
      }, { once: true });
    });
    return cdp;
  }

  #dispatch(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? 'CDP 错误'}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string') {
      const key = message.method;
      const set = this.#listeners.get(key);
      if (set) for (const fn of [...set]) {
        try {
          fn(message.params ?? {}, message.sessionId ?? null);
        } catch {
          /* listener failure never breaks the socket */
        }
      }
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.#closed || this.#ws.readyState !== 1) {
      return Promise.reject(new Error(this.#closeReason || 'CDP 未连接'));
    }
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#ws.send(JSON.stringify(message));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  waitFor(method, predicate = null, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const set = this.#listeners.get(method) ?? new Set();
      this.#listeners.set(method, set);
      const handler = (params, sessionId) => {
        if (predicate && !predicate(params, sessionId)) return;
        clearTimeout(timer);
        set.delete(handler);
        resolve(params);
      };
      set.add(handler);
      const timer = setTimeout(() => {
        set.delete(handler);
        reject(new Error(`等待事件超时：${method}`));
      }, timeoutMs);
    });
  }

  close() {
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Instance registry (one profile can be held by a single session; a session
// may hold several profiles, as long as every instance gets its own tab in
// the panel)
// ---------------------------------------------------------------------------

const instances = new Map();

function sessionIdOf(args) {
  const id = String(args?.session_id ?? '').trim();
  return id || 'default';
}

function shortId(id) {
  const text = String(id ?? '');
  return text.length <= 14 ? text : `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function ownedBy(sessionId) {
  return [...instances.values()].filter((instance) => instance.sessionId === sessionId);
}

function requireInstance(args) {
  const sessionId = sessionIdOf(args);
  const profileId = String(args?.profile_id ?? '').trim();
  if (profileId) {
    const instance = instances.get(profileId);
    if (!instance) {
      throw new Error(`Profile ${profileId} 还没有被 MCP 接管。调用 list_and_bind_profile 或 session_attach 先接管。`);
    }
    if (instance.sessionId !== sessionId) {
      throw new Error(`Profile ${profileId} 正被会话 ${instance.sessionId} 独占，不能从会话 ${sessionId} 操作。`);
    }
    return instance;
  }
  const owned = ownedBy(sessionId);
  if (owned.length === 0) {
    throw new Error(`会话 ${sessionId} 还没有绑定浏览器。先调用 list_and_bind_profile（action=bind 或 auto-bind）或 session_attach。`);
  }
  if (owned.length > 1) {
    const list = owned.map((item) => `${item.name} [${item.profileId}]`).join('、');
    throw new Error(`会话 ${sessionId} 有多个实例：${list}。请传 profile_id 指明要操作哪一个。`);
  }
  return owned[0];
}

async function attachTarget(cdp, targetId) {
  if (!targetId || typeof targetId !== 'string') {
    throw new Error(`attachToTarget 缺少 targetId（收到 ${JSON.stringify(targetId)}）`);
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'DOM.enable']) {
        await cdp.send(method, {}, sessionId).catch(() => {});
      }
      return sessionId;
    } catch (error) {
      lastError = error;
      process.stderr.write(`[shardx] attachToTarget attempt ${attempt + 1} target=${targetId}: ${error.message}\n`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError;
}

async function attachPage(cdp, wantedTargetId = '') {
  const { targetInfos = [] } = await cdp.send('Target.getTargets', {});
  const pages = targetInfos
    .filter((target) => target.type === 'page')
    .map((target) => ({ ...target, id: target.targetId ?? target.id }));
  if (pages.length === 0) throw new Error('实例里没有可用的页面目标');
  process.stderr.write(`[shardx] pages=${pages.map((page) => `${page.id}:${page.url}`).join(' | ')}\n`);
  const page = (wantedTargetId ? pages.find((target) => target.id === wantedTargetId) : null)
    ?? pages.find((target) => target.url && !target.url.startsWith('chrome://'))
    ?? pages[0];
  const sessionId = await attachTarget(cdp, page.id);
  return { sessionId, targetId: page.id };
}

function wsUrlOf(started) {
  const cdp = started?.cdp ?? {};
  return started?.cdp?.web_socket_debugger_url
    ?? started?.cdp?.webSocketDebuggerUrl
    ?? started?.web_socket_debugger_url
    ?? started?.webSocketDebuggerUrl
    ?? cdp.ws_url
    ?? started?.wsUrl;
}

async function startProfile(profileId, options = {}) {
  const body = {};
  if (options.headless === true) body.headless = true;
  if (options.password) body.password = String(options.password);
  try {
    return await api('POST', `/profiles/${encodeURIComponent(profileId)}/start`, { body, timeoutMs: START_TIMEOUT_MS });
  } catch (error) {
    const running = await api('GET', '/running').catch(() => null);
    const list = asArray(running);
    const hit = list.find((item) => item?.id === profileId || item?.profile_id === profileId);
    if (hit) return hit;
    throw error;
  }
}

async function startOrFindRunning(profileId, options = {}) {
  const running = await api('GET', '/running').catch(() => null);
  const hit = asArray(running).find((item) => item?.id === profileId || item?.profile_id === profileId);
  if (hit && wsUrlOf(hit)) return hit;
  return startProfile(profileId, options);
}

async function profileName(profileId) {
  try {
    const profile = await api('GET', `/profiles/${encodeURIComponent(profileId)}`);
    return String(profile?.name ?? '') || profileId;
  } catch {
    return profileId;
  }
}

async function openInstance(sessionId, profileId, name, started, source) {
  const url = wsUrlOf(started);
  if (!url) throw new Error('启动响应里没有 cdp.web_socket_debugger_url');
  const cdp = await Cdp.open(url);
  const { sessionId: pageSession, targetId } = await attachPage(cdp);
  const instance = {
    sessionId,
    profileId,
    name: name || profileId,
    cdp,
    pageSession,
    targetId,
    startedAt: Date.now(),
    source,
  };
  instances.set(profileId, instance);
  saveMapping(profileId, instance.name, sessionId, source);
  return instance;
}

async function bind(sessionId, profileId, name, options = {}) {
  const holder = instances.get(profileId);
  if (holder) {
    if (holder.sessionId !== sessionId) {
      throw new Error(`Profile ${profileId} 正被会话 ${holder.sessionId} 独占，先让那个会话 session_stop_and_release。`);
    }
    return holder;
  }
  const started = await startOrFindRunning(profileId, options);
  return openInstance(sessionId, profileId, name, started, 'mcp');
}

async function attachRunning(sessionId, profileId, name, options = {}) {
  const holder = instances.get(profileId);
  if (holder) {
    if (holder.sessionId !== sessionId) {
      throw new Error(`Profile ${profileId} 正被会话 ${holder.sessionId} 独占，先让那个会话 session_stop_and_release。`);
    }
    return holder;
  }
  const started = await startOrFindRunning(profileId, options);
  return openInstance(sessionId, profileId, name, started, 'mcp-attach');
}

async function release(sessionId, profileId = '') {
  const targets = profileId
    ? [instances.get(profileId)].filter(Boolean)
    : ownedBy(sessionId);
  const released = [];
  for (const instance of targets) {
    if (instance.sessionId !== sessionId) {
      throw new Error(`Profile ${instance.profileId} 属于会话 ${instance.sessionId}，不能从会话 ${sessionId} 关闭。`);
    }
    instances.delete(instance.profileId);
    try {
      instance.cdp.close();
    } catch {
      /* ignore */
    }
    try {
      await api('POST', `/profiles/${encodeURIComponent(instance.profileId)}/stop`);
    } catch {
      /* the browser may already be gone */
    }
    removeMapping(instance.profileId, sessionId);
    released.push(instance.profileId);
  }
  return released;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面脚本异常';
    throw new Error(String(detail));
  }
  return result.result?.value;
}

function selectorExpr(selector) {
  return selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body';
}

const MARKDOWN_FN = `(() => {
  const root = SEL;
  if (!root) return '';
  const out = [];
  const push = (value) => {
    const text = String(value ?? '').replace(/\\s+/g, ' ').trim();
    if (text) out.push(text);
  };
  const block = (tag) => ['p','div','section','article','header','footer','nav','main','table','ul','ol','tr'].includes(tag);
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 3) { push(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (['script','style','noscript','svg','template','iframe'].includes(tag)) return;
    if (/^h[1-6]$/.test(tag)) {
      out.push('#'.repeat(Number(tag[1])) + ' ' + (node.innerText || '').replace(/\\s+/g, ' ').trim());
      return;
    }
    if (tag === 'a') { out.push('[' + (node.innerText || '').replace(/\\s+/g,' ').trim() + '](' + (node.getAttribute('href') || '') + ')'); return; }
    if (tag === 'img') { out.push('![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')'); return; }
    if (tag === 'li') { out.push('- ' + (node.innerText || '').replace(/\\s+/g,' ').trim()); return; }
    if (tag === 'br') { out.push(''); return; }
    if (block(tag)) out.push('');
    for (const child of node.childNodes) walk(child);
    if (block(tag)) out.push('');
  };
  walk(root);
  return out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
})()`;

const FORMS_FN = `(() => {
  const root = SEL || document;
  if (!root) return '[]';
  const items = [];
  for (const element of root.querySelectorAll('input,textarea,select,button')) {
    items.push({
      tag: element.tagName.toLowerCase(),
      type: element.type || '',
      name: element.name || '',
      id: element.id || '',
      placeholder: element.placeholder || '',
      label: element.labels && element.labels[0] ? (element.labels[0].innerText || '').trim() : '',
      required: Boolean(element.required),
      disabled: Boolean(element.disabled),
      value: element.type === 'password' ? '' : (element.value || '')
    });
  }
  return JSON.stringify(items, null, 2);
})()`;

async function boxOf(cdp, sessionId, selector) {
  const expression = `(() => {
    const element = ${selectorExpr(selector)};
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  return evaluate(cdp, sessionId, expression);
}

async function clickPoint(cdp, sessionId, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, sessionId);
}

async function click(cdp, sessionId, args) {
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) && args.x !== undefined && args.y !== undefined) {
    const x = Number(args.x);
    const y = Number(args.y);
    await clickPoint(cdp, sessionId, x, y);
    return { clicked: { x, y } };
  }
  if (!args.selector) throw new Error('click 需要 selector 或 x/y');
  const box = await boxOf(cdp, sessionId, args.selector);
  if (box) {
    await clickPoint(cdp, sessionId, box.x, box.y);
    return { clicked: { selector: args.selector, x: box.x, y: box.y } };
  }
  const fallback = await evaluate(cdp, sessionId, `(() => {
    const element = ${selectorExpr(args.selector)};
    if (!element) return false;
    element.click();
    return true;
  })()`);
  if (!fallback) throw new Error(`找不到可点击的元素：${args.selector}`);
  return { clicked: { selector: args.selector, via: 'element.click()' } };
}

async function typeText(cdp, sessionId, args) {
  if (!args.selector) throw new Error('type 需要 selector');
  const focused = await evaluate(cdp, sessionId, `(() => {
    const element = ${selectorExpr(args.selector)};
    if (!element) return false;
    element.focus();
    if (typeof element.select === 'function' && element.tagName !== 'SELECT') element.select();
    return document.activeElement === element;
  })()`);
  if (!focused) throw new Error(`无法聚焦元素：${args.selector}`);
  const text = String(args.text ?? args.value ?? '');
  await cdp.send('Input.insertText', { text }, sessionId);
  return { typed: text.length, selector: args.selector };
}

async function scroll(cdp, sessionId, args) {
  if (args.selector) {
    await evaluate(cdp, sessionId, `(() => {
      const element = ${selectorExpr(args.selector)};
      if (!element) return false;
      element.scrollIntoView({ block: 'start', behavior: 'instant' });
      return true;
    })()`);
    return { scrolled: { selector: args.selector } };
  }
  const delta = Number.isFinite(Number(args.y)) ? Number(args.y) : 600;
  await evaluate(cdp, sessionId, `window.scrollBy(0, ${delta})`);
  return { scrolled: delta };
}

async function extractValue(cdp, sessionId, { selector = '', mode = 'markdown' } = {}) {
  if (mode === 'html') {
    return String(await evaluate(cdp, sessionId, `(() => {
      const element = ${selectorExpr(selector)};
      return element ? element.outerHTML : '';
    })()`) ?? '');
  }
  if (mode === 'text') {
    return String(await evaluate(cdp, sessionId, `(() => {
      const element = ${selectorExpr(selector)};
      return element ? element.innerText : '';
    })()`) ?? '');
  }
  if (mode === 'forms') {
    return String(await evaluate(cdp, sessionId, FORMS_FN.replace('SEL', selectorExpr(selector))) ?? '[]');
  }
  return String(await evaluate(cdp, sessionId, MARKDOWN_FN.replace('SEL', selectorExpr(selector))) ?? '');
}

async function runSkillOnInstance(instance, steps) {
  const results = [];
  const { cdp, pageSession } = instance;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] ?? {};
    const action = String(step.action ?? '');
    try {
      let result;
      if (action === 'navigate') {
        const url = String(step.url ?? '').trim();
        if (!url) throw new Error('navigate 缺少 url');
        const settled = cdp.waitFor('Page.loadEventFired', null, 45_000);
        const navigation = await cdp.send('Page.navigate', { url }, pageSession, 45_000);
        if (navigation.errorText) throw new Error(`导航失败：${navigation.errorText}`);
        await settled.catch(() => {});
        result = { url };
      } else if (action === 'reload') {
        const settled = cdp.waitFor('Page.loadEventFired', null, 45_000);
        await cdp.send('Page.reload', {}, pageSession, 45_000);
        await settled.catch(() => {});
        result = { reloaded: true };
      } else if (action === 'wait') {
        if (step.selector) {
          const timeout = Number(step.timeout_ms) > 0 ? Number(step.timeout_ms) : 30_000;
          const deadline = Date.now() + timeout;
          let found = false;
          while (Date.now() < deadline) {
            found = Boolean(await evaluate(cdp, pageSession, `!!document.querySelector(${JSON.stringify(String(step.selector))})`));
            if (found) break;
            await sleep(250);
          }
          if (!found) throw new Error(`等待元素超时：${step.selector}`);
          result = { selector: String(step.selector), found: true };
        } else {
          const ms = Math.max(0, Number(step.ms ?? 1000));
          await sleep(ms);
          result = { waited: ms };
        }
      } else if (action === 'click') {
        result = await click(cdp, pageSession, step);
      } else if (action === 'type') {
        result = await typeText(cdp, pageSession, step);
      } else if (action === 'evaluate') {
        const script = String(step.script ?? step.expression ?? '').trim();
        if (!script) throw new Error('evaluate 缺少 script');
        const value = await evaluate(cdp, pageSession, script);
        result = value === undefined ? null : value;
      } else if (action === 'extract') {
        const mode = String(step.mode ?? 'text');
        const selector = String(step.selector ?? '');
        const value = await extractValue(cdp, pageSession, { selector, mode });
        result = { mode, selector, value };
      } else {
        throw new Error(`未知步骤 action：${action}`);
      }
      results.push({ index, action, ok: true, result });
    } catch (error) {
      results.push({ index, action, ok: false, error: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Launcher process discovery and control
// ---------------------------------------------------------------------------

async function listLauncherProcesses(launcherPath = '') {
  if (process.platform !== 'win32') return [];
  const escaped = String(launcherPath ?? '').replace(/'/g, "''");
  const filter = escaped
    ? `$_.ExecutablePath -eq '${escaped}' -or $_.Name -like 'ShardBrowser*' -or $_.Name -like 'shardx*'`
    : `$_.Name -like 'ShardBrowser*' -or $_.Name -like 'shardx*'`;
  const script = `$items = Get-CimInstance Win32_Process | Where-Object { ${filter} } | Select-Object ProcessId,ExecutablePath,CommandLine; $items | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 },
    );
    const trimmed = String(stdout ?? '').trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => ({
        pid: Number(row.ProcessId),
        path: String(row.ExecutablePath ?? ''),
        command: String(row.CommandLine ?? ''),
      }))
      .filter((row) => Number.isFinite(row.pid));
  } catch {
    return [];
  }
}

async function stopLauncher(launcherPath = '') {
  const processes = await listLauncherProcesses(launcherPath);
  for (const item of processes) {
    try {
      process.kill(item.pid, 'SIGTERM');
    } catch {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(item.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        /* process already gone */
      }
    }
  }
  return processes;
}

async function probeHealth(port, timeoutMs = 2000) {
  if (!port) return { ok: false, body: null };
  try {
    const response = await fetch(`http://127.0.0.1:${Math.trunc(port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, body };
  } catch {
    return { ok: false, body: null };
  }
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { ok } = await probeHealth(port, 2500);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

async function serverStatus() {
  const path = settingsPath();
  let raw = null;
  let parseError = '';
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const state = readWorkspaceState();
  const port = Number(raw?.api_port) || 0;
  const apiEnabled = Boolean(String(raw?.api_secret ?? '').trim());
  const processes = await listLauncherProcesses(state.settings.launcher_path);
  const launcherPath = state.settings.launcher_path || processes[0]?.path || '';
  const health = await probeHealth(port);
  const version = String(health.body?.version ?? raw?.version ?? '');
  return {
    found: Boolean(raw),
    running: health.ok,
    version: version || null,
    port: port || null,
    apiEnabled,
    dataRoot: String(raw?.data_root ?? ''),
    settingsPath: path,
    launcherPath,
    processes,
    statePath: workspaceStatePath(),
    error: raw ? undefined : parseError || '未找到 ShardX 启动器设置',
  };
}

async function controlServer(action, launcherPath) {
  const status = await serverStatus();
  const port = status.port || launcherCache?.port || 0;
  const path = String(launcherPath ?? '').trim() || status.launcherPath;
  let stopped = [];
  if (action === 'stop' || action === 'restart') {
    stopped = await stopLauncher(path);
    await sleep(600);
  }
  let started = false;
  if (action === 'start' || action === 'restart') {
    if (!path) {
      throw new Error('没有启动器路径。先调用 workspace_state（action=settings）保存 launcher_path，或在 server_control 里传 launcher_path。');
    }
    if (!existsSync(path)) throw new Error(`启动器不存在：${path}`);
    const child = spawn(path, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    let healthPort = port;
    for (let attempt = 0; attempt < 20 && !healthPort; attempt += 1) {
      await sleep(500);
      launcherCache = null;
      try {
        healthPort = launcher().port;
      } catch {
        /* settings not written yet */
      }
    }
    started = healthPort ? await waitForHealth(healthPort, 20_000) : false;
  }
  const after = await serverStatus();
  return { action, stopped, started, ...after };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function formatProfiles(profiles, live, mappings) {
  const rows = profiles.map((profile, index) => {
    const session = live.get(profile.id);
    const mapping = mappings.get(profile.id);
    const flags = [
      profile.running === true ? '运行中' : '',
      session ? `MCP 会话 ${shortId(session)}` : '',
      !session && mapping ? `映射 ${shortId(mapping.session_id)}` : '',
    ].filter(Boolean).join(' · ');
    return `${index + 1}. ${profile.name ?? '(未命名)'}  [${profile.id}]${flags ? `  ${flags}` : ''}${profile.folder ? `  📁 ${profile.folder}` : '  📁 未分类'}`;
  });
  return `${profiles.length} 个指纹环境\n${rows.join('\n')}`;
}

function cleanFolderName(value) {
  return String(value ?? '').trim();
}

function folderLabel(value) {
  return cleanFolderName(value) || '未分类';
}

async function foldersOverview({ includeProfiles = false } = {}) {
  const [profilesRaw, runningRaw, foldersRaw] = await Promise.all([
    api('GET', '/profiles'),
    api('GET', '/running').catch(() => []),
    api('GET', '/folders').catch(() => []),
  ]);
  const profiles = asArray(profilesRaw);
  const runningIds = new Set(
    asArray(runningRaw).map((item) => String(item?.profile_id ?? item?.id ?? '')).filter(Boolean),
  );
  const state = readWorkspaceState();
  const groups = new Map();
  for (const profile of profiles) {
    const key = folderLabel(profile?.folder);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(profile);
  }
  for (const raw of asArray(foldersRaw)) {
    const name = typeof raw === 'string' ? raw : cleanFolderName(raw?.name ?? raw?.folder ?? raw?.id);
    if (name && !groups.has(name)) groups.set(name, []);
  }
  const folders = [...groups.entries()]
    .map(([folder, list]) => {
      const skills = state.assignments
        .filter((item) => item.target_type === 'folder' && cleanFolderName(item.target_id) === folder)
        .map((item) => item.skill_id);
      const row = {
        folder: folder === '未分类' ? '' : folder,
        label: folder,
        count: list.length,
        running: list.filter((item) => item.running === true || runningIds.has(String(item.id))).length,
        skills,
      };
      if (includeProfiles) {
        row.profiles = list.map((item) => ({
          id: item.id,
          name: item.name ?? '',
          running: item.running === true || runningIds.has(String(item.id)),
        }));
      }
      return row;
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  return {
    count: folders.length,
    totalProfiles: profiles.length,
    running: runningIds.size,
    folders,
  };
}

const KEY_CODES = {
  Enter: ['Enter', 13],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36],
  End: ['End', 35],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  Insert: ['Insert', 45],
  Space: [' ', 32],
};

async function pressKey(cdp, sessionId, combo) {
  const parts = String(combo ?? '').split('+').map((part) => part.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  if (!key) throw new Error('press 需要 key，例如 Enter 或 Control+A');
  const modifiers = parts.reduce((mask, part) => {
    const name = part.toLowerCase();
    if (name === 'alt') return mask | 1;
    if (name === 'control' || name === 'ctrl') return mask | 2;
    if (name === 'meta' || name === 'cmd') return mask | 4;
    if (name === 'shift') return mask | 8;
    return mask;
  }, 0);
  const [code, vk] = KEY_CODES[key] ?? [key.length === 1 ? `Key${key.toUpperCase()}` : key, key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0];
  const base = {
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
  return { key: combo, modifiers };
}

async function waitForPage(cdp, sessionId, options = {}) {
  const timeout = Number(options.timeout_ms) > 0 ? Number(options.timeout_ms) : 30_000;
  const selector = String(options.selector ?? '').trim();
  const text = String(options.text ?? '');
  const url = String(options.url ?? '').trim();
  const expression = String(options.expression ?? options.script ?? '').trim();
  if (!selector && !text && !url && !expression) {
    throw new Error('wait 需要 selector / text / url / expression 至少一个');
  }
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, sessionId, `(() => {
      const selector = ${JSON.stringify(selector)};
      const text = ${JSON.stringify(text)};
      const url = ${JSON.stringify(url)};
      const expression = ${JSON.stringify(expression)};
      const result = { url: location.href, title: document.title };
      if (selector) {
        const element = document.querySelector(selector);
        result.selectorFound = Boolean(element);
        if (element && typeof element.getBoundingClientRect === 'function') {
          const rect = element.getBoundingClientRect();
          result.selectorVisible = rect.width > 0 && rect.height > 0;
        }
        if (!element) return { ...result, ok: false };
      }
      if (text) {
        const bodyText = document.body ? document.body.innerText : '';
        result.textFound = bodyText.includes(text);
        if (!result.textFound) return { ...result, ok: false };
      }
      if (url) {
        result.urlMatched = location.href.includes(url);
        if (!result.urlMatched) return { ...result, ok: false };
      }
      if (expression) {
        try {
          result.expressionValue = Boolean(Function('"use strict"; return (' + expression + ')')());
        } catch (error) {
          return { ...result, ok: false, error: String(error) };
        }
        if (!result.expressionValue) return { ...result, ok: false };
      }
      return { ...result, ok: true };
    })()`).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (last && last.ok) return { waited: timeout - Math.max(0, deadline - Date.now()), ...last };
    await sleep(250);
  }
  throw new Error(`等待超时（${timeout}ms）：${JSON.stringify(last)}`);
}

async function pageSnapshot(cdp, sessionId, { maxText = 6000, maxLinks = 80, maxFields = 60 } = {}) {
  return evaluate(cdp, sessionId, `(() => {
    const clip = (value, limit) => String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, limit);
    const links = Array.from(document.querySelectorAll('a[href]'))
      .slice(0, ${Number(maxLinks) || 80})
      .map((a) => ({ text: clip(a.innerText, 80), href: a.href }))
      .filter((item) => item.href && !item.href.startsWith('javascript:'));
    const fields = Array.from(document.querySelectorAll('input, textarea, select'))
      .slice(0, ${Number(maxFields) || 60})
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.type || '',
        name: element.name || '',
        id: element.id || '',
        placeholder: element.placeholder || '',
        label: element.labels && element.labels[0] ? clip(element.labels[0].innerText, 80) : '',
        value: element.type === 'password' ? '' : clip(element.value, 120),
        options: element.tagName === 'SELECT'
          ? Array.from(element.options).slice(0, 20).map((option) => ({ value: option.value, text: clip(option.text, 60) }))
          : undefined,
      }));
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
      .slice(0, 60)
      .map((element) => clip(element.innerText || element.value, 80))
      .filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      text: clip(document.body ? document.body.innerText : '', ${Number(maxText) || 6000}),
      links,
      fields,
      buttons,
      scroll: { x: window.scrollX, y: window.scrollY, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    };
  })()`);
}

async function toolListAndBind(args) {
  const action = String(args.action ?? 'list');
  const live = new Map([...instances.values()].map((instance) => [instance.profileId, instance.sessionId]));
  const mappings = new Map(readWorkspaceState().mappings.map((item) => [item.profile_id, item]));

  if (action === 'list' || action === 'folders') {
    if (action === 'folders') {
      return JSON.stringify(await foldersOverview({ includeProfiles: args.include_profiles === true }), null, 2);
    }
    const all = asArray(await api('GET', '/profiles'));
    const folder = cleanFolderName(args.folder);
    const query = String(args.query ?? '').trim().toLowerCase();
    let filtered = folder ? all.filter((profile) => folderLabel(profile.folder) === folder) : all;
    if (query) {
      filtered = filtered.filter((profile) => `${profile.name ?? ''} ${profile.id} ${profile.folder ?? ''}`.toLowerCase().includes(query));
    }
    const limit = Number(args.limit) > 0 ? Math.trunc(Number(args.limit)) : filtered.length;
    const shown = filtered.slice(0, limit);
    const counts = new Map();
    for (const profile of all) {
      const key = folderLabel(profile.folder);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const header = `📁 文件夹 ${counts.size} 个：${[...counts.entries()].map(([name, n]) => `${name}(${n})`).join(' / ')}`;
    const body = formatProfiles(shown, live, mappings);
    return shown.length === filtered.length
      ? `${header}\n${body}`
      : `${header}\n${body}\n（显示 ${shown.length}/${filtered.length}；用 limit / folder / query 缩小范围）`;
  }

  if (action === 'bind') {
    const profileId = String(args.profile_id ?? '').trim();
    if (!profileId) throw new Error('action=bind 需要 profile_id');
    const name = await profileName(profileId);
    const session = await bind(sessionIdOf(args), profileId, name, {
      headless: args.headless === true,
      password: args.password,
    });
    const owned = ownedBy(session.sessionId).length;
    return `已绑定并启动：${session.name}\nprofile_id: ${profileId}\nsession_id: ${session.sessionId}\n该会话现在有 ${owned} 个实例${owned > 1 ? '（每个实例在面板里各占一个标签）' : ''}\nCDP page session: ${session.pageSession}`;
  }

  if (action === 'auto-bind') {
    const profiles = await api('GET', '/profiles');
    const list = asArray(profiles);
    const busy = new Set(live.keys());
    const folder = cleanFolderName(args.folder);
    for (const profile of list) {
      if (busy.has(profile.id)) continue;
      const running = profile.running === true || String(profile.status ?? '').toLowerCase() === 'running';
      if (running) continue;
      if (folder && folderLabel(profile.folder) !== folder) continue;
      const name = String(profile.name ?? '') || profile.id;
      const instance = await bind(sessionIdOf(args), profile.id, name, {
        headless: args.headless === true,
        password: args.password,
      });
      return `已自动绑定：${instance.name}\nprofile_id: ${profile.id}\nsession_id: ${instance.sessionId}\n文件夹：${folderLabel(profile.folder)}`;
    }
    throw new Error(folder ? `文件夹「${folder}」里没有空闲的 profile` : '没有空闲的 profile 可自动绑定');
  }

  throw new Error(`未知 action：${action}`);
}

async function toolFolderList(args) {
  return JSON.stringify(await foldersOverview({ includeProfiles: args.include_profiles === true }), null, 2);
}

async function toolFolderRename(args) {
  const folder = cleanFolderName(args.folder);
  const name = cleanFolderName(args.name);
  if (!folder) throw new Error('folder_rename 需要 folder');
  if (!name) throw new Error('folder_rename 需要 name');
  const result = await api('PATCH', `/folders/${encodeURIComponent(folder)}`, { body: { name } });
  return JSON.stringify({ renamed: folder, to: name, result, folders: (await foldersOverview()).folders }, null, 2);
}

async function toolFolderDelete(args) {
  const folder = cleanFolderName(args.folder);
  if (!folder) throw new Error('folder_delete 需要 folder');
  const deleteProfiles = args.delete_profiles === true;
  const result = await api('DELETE', `/folders/${encodeURIComponent(folder)}`, {
    query: { delete_profiles: deleteProfiles ? 'true' : 'false' },
  });
  return JSON.stringify({
    deleted_folder: folder,
    delete_profiles: deleteProfiles,
    result,
    folders: (await foldersOverview()).folders,
  }, null, 2);
}

async function toolProfileGet(args) {
  const profileId = String(args.profile_id ?? args.id ?? '').trim();
  if (!profileId) throw new Error('profile_get 需要 profile_id');
  const profile = await api('GET', `/profiles/${encodeURIComponent(profileId)}`);
  return JSON.stringify(profile, null, 2);
}

async function toolProfileCreate(args) {
  const folder = cleanFolderName(args.folder);
  let fingerprint = args.fingerprint;
  let generatedFor = '';
  if (!fingerprint) {
    const platform = String(args.platform ?? '').trim();
    generatedFor = platform;
    const response = await api('GET', platform ? `/fingerprint/new/${encodeURIComponent(platform)}` : '/fingerprint/new');
    fingerprint = response?.fingerprint ?? response;
  }
  const body = { fingerprint };
  for (const key of ['name', 'notes', 'proxy', 'proxy_id', 'color', 'refresh_rate']) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') body[key] = args[key];
  }
  if (Array.isArray(args.extensions)) body.extensions = args.extensions;
  const path = folder ? `/folders/${encodeURIComponent(folder)}/profiles` : '/profiles';
  const profile = await api('POST', path, { body });
  return JSON.stringify({ created: profile, folder: folder || '', platform: generatedFor }, null, 2);
}

async function toolProfileEdit(args) {
  const profileId = String(args.profile_id ?? args.id ?? '').trim();
  if (!profileId) throw new Error('profile_edit 需要 profile_id');
  const body = {};
  for (const key of ['name', 'notes', 'folder', 'proxy_id', 'proxy', 'color', 'refresh_rate', 'rev', 'password']) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  if (Array.isArray(args.extensions)) body.extensions = args.extensions;
  if (args.fingerprint && typeof args.fingerprint === 'object') body.fingerprint = args.fingerprint;
  if (Object.keys(body).length === 0) throw new Error('profile_edit 没有可修改的字段');
  const profile = await api('PATCH', `/profiles/${encodeURIComponent(profileId)}`, { body });
  return JSON.stringify({ edited: profileId, changes: Object.keys(body), profile }, null, 2);
}

async function toolProfileDelete(args) {
  const profileId = String(args.profile_id ?? args.id ?? '').trim();
  if (!profileId) throw new Error('profile_delete 需要 profile_id');
  const result = await api('DELETE', `/profiles/${encodeURIComponent(profileId)}`);
  return JSON.stringify({ trashed: profileId, result }, null, 2);
}

async function toolProxyList() {
  const proxies = asArray(await api('GET', '/proxies'));
  return JSON.stringify(proxies, null, 2);
}

async function toolProxyAdd(args) {
  const body = {};
  for (const key of ['proxy', 'kind', 'host', 'port', 'username', 'password', 'name', 'country', 'notes']) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') body[key] = args[key];
  }
  if (!body.proxy && !body.host) throw new Error('proxy_add 需要 proxy 字符串或 host+port');
  const proxy = await api('POST', '/proxies', { body });
  return JSON.stringify({ added: proxy }, null, 2);
}

async function toolProxyDelete(args) {
  const proxyId = String(args.proxy_id ?? args.id ?? '').trim();
  if (!proxyId) throw new Error('proxy_delete 需要 proxy_id');
  const result = await api('DELETE', `/proxies/${encodeURIComponent(proxyId)}`);
  return JSON.stringify({ deleted: proxyId, result }, null, 2);
}

async function toolFingerprintNew(args) {
  const platform = String(args.platform ?? '').trim();
  const response = await api('GET', platform ? `/fingerprint/new/${encodeURIComponent(platform)}` : '/fingerprint/new');
  return JSON.stringify(response, null, 2);
}

async function toolFingerprintList() {
  return JSON.stringify(asArray(await api('GET', '/fingerprints')), null, 2);
}

async function toolSessionAttach(args) {
  const sessionId = sessionIdOf(args);
  const profileId = String(args.profile_id ?? '').trim();
  if (!profileId) throw new Error('session_attach 需要 profile_id');
  const name = String(args.name ?? '').trim() || (await profileName(profileId));
  const existing = instances.get(profileId);
  const instance = await attachRunning(sessionId, profileId, name, {
    headless: args.headless === true,
    password: args.password,
  });
  const owned = ownedBy(sessionId).length;
  return `${existing ? '已复用' : '已接管'}实例：${instance.name}\nprofile_id: ${profileId}\nsession_id: ${sessionId}\n该会话现在有 ${owned} 个实例\nCDP page session: ${instance.pageSession}`;
}

async function toolNavigate(args) {
  const instance = requireInstance(args);
  const url = String(args.url ?? '').trim();
  if (!url) throw new Error('navigate 需要 url');
  const waitUntil = String(args.wait_until ?? 'networkidle');
  const cdp = instance.cdp;

  let settled = Promise.resolve();
  if (waitUntil === 'load' || waitUntil === 'networkidle') {
    settled = cdp.waitFor('Page.loadEventFired', null, 45_000);
  } else {
    settled = cdp.waitFor('Page.domContentEventFired', null, 45_000);
  }
  const navigation = await cdp.send('Page.navigate', { url }, instance.pageSession, 45_000);
  if (navigation.errorText) throw new Error(`导航失败：${navigation.errorText}`);
  await settled.catch(() => {});
  if (waitUntil === 'networkidle') await sleep(700);

  const info = await evaluate(cdp, instance.pageSession, '({ url: location.href, title: document.title })');
  return `已打开 ${info?.url ?? url}\n标题：${info?.title ?? ''}`;
}

async function toolInteract(args) {
  const instance = requireInstance(args);
  const action = String(args.action ?? '');
  const cdp = instance.cdp;
  const sid = instance.pageSession;
  const selector = String(args.selector ?? '').trim();

  if (action === 'click') {
    const result = await click(cdp, sid, args);
    return `click 完成 ${JSON.stringify(result.clicked)}`;
  }
  if (action === 'type') {
    const result = await typeText(cdp, sid, args);
    return `已向 ${result.selector} 输入 ${result.typed} 个字符`;
  }
  if (action === 'scroll') {
    const result = await scroll(cdp, sid, args);
    return `scroll 完成 ${JSON.stringify(result.scrolled)}`;
  }
  if (action === 'evaluate_js') {
    const script = String(args.script ?? '').trim();
    if (!script) throw new Error('evaluate_js 需要 script');
    const value = await evaluate(cdp, sid, script);
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }
  if (action === 'hover') {
    if (!selector) throw new Error('hover 需要 selector');
    const box = await boxOf(cdp, sid, selector);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      button: 'none',
    }, sid);
    return `已悬停 ${selector}`;
  }
  if (action === 'press') {
    const key = String(args.key ?? '').trim();
    if (!key) throw new Error('press 需要 key，例如 Enter 或 Control+A');
    const result = await pressKey(cdp, sid, key);
    return `已按键 ${result.key}`;
  }
  if (action === 'select') {
    if (!selector) throw new Error('select 需要 selector');
    const value = String(args.value ?? args.text ?? '');
    const result = await evaluate(cdp, sid, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { ok: false, error: 'not found' };
      if (element.tagName !== 'SELECT') return { ok: false, error: 'not a select' };
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: element.value, selectedIndex: element.selectedIndex };
    })()`);
    if (result && result.ok === false) throw new Error(`select 失败：${result.error}`);
    return JSON.stringify(result);
  }
  if (action === 'check' || action === 'uncheck') {
    if (!selector) throw new Error(`${action} 需要 selector`);
    const checked = action === 'check';
    const result = await evaluate(cdp, sid, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { ok: false, error: 'not found' };
      if (element.checked !== ${checked}) element.click();
      return { ok: true, checked: element.checked };
    })()`);
    if (result && result.ok === false) throw new Error(`${action} 失败：${result.error}`);
    return JSON.stringify(result);
  }
  if (action === 'back' || action === 'forward') {
    const { currentIndex, entries = [] } = await cdp.send('Page.getNavigationHistory', {}, sid);
    const target = entries[currentIndex + (action === 'back' ? -1 : 1)];
    if (!target) return `没有可${action === 'back' ? '后退' : '前进'}的历史`;
    await cdp.send('Page.navigateToHistoryEntry', { entryId: target.id }, sid);
    await sleep(600);
    return `${action === 'back' ? '已后退' : '已前进'}到 ${target.url}`;
  }
  if (action === 'reload') {
    await cdp.send('Page.reload', { ignoreCache: args.ignore_cache === true }, sid);
    await sleep(800);
    return '已刷新';
  }
  if (action === 'get_text') {
    if (!selector) return String(await evaluate(cdp, sid, 'document.body ? document.body.innerText : "'));
    return String(await evaluate(cdp, sid, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      return element ? element.innerText : '';
    })()`));
  }
  if (action === 'get_html') {
    const target = selector
      ? `(() => { const element = document.querySelector(${JSON.stringify(selector)}); return element ? element.outerHTML : ''; })()`
      : 'document.documentElement.outerHTML';
    return String(await evaluate(cdp, sid, target));
  }
  if (action === 'get_value') {
    if (!selector) throw new Error('get_value 需要 selector');
    return String(await evaluate(cdp, sid, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      return element ? element.value : '';
    })()`));
  }
  if (action === 'exists') {
    if (!selector) throw new Error('exists 需要 selector');
    const result = await evaluate(cdp, sid, `(() => {
      const list = document.querySelectorAll(${JSON.stringify(selector)});
      const first = list[0];
      if (!first) return { exists: false, count: 0, visible: false };
      const rect = first.getBoundingClientRect();
      return { exists: true, count: list.length, visible: rect.width > 0 && rect.height > 0 };
    })()`);
    return JSON.stringify(result);
  }
  if (action === 'count') {
    if (!selector) throw new Error('count 需要 selector');
    return String(await evaluate(cdp, sid, `document.querySelectorAll(${JSON.stringify(selector)}).length`));
  }
  if (action === 'links') {
    const result = await evaluate(cdp, sid, `Array.from(document.querySelectorAll('a[href]')).slice(0, 200).map((a) => ({ text: (a.innerText || '').trim().slice(0, 120), href: a.href })).filter((item) => item.href)`);
    return JSON.stringify(result, null, 2);
  }
  if (action === 'wait') {
    const result = await waitForPage(cdp, sid, args);
    return JSON.stringify(result);
  }
  if (action === 'snapshot') {
    const result = await pageSnapshot(cdp, sid, args);
    return JSON.stringify(result, null, 2);
  }
  if (action === 'tabs') {
    return toolSessionTabs({ ...args, session_id: instance.sessionId, profile_id: instance.profileId, action: String(args.tab_action ?? 'list') });
  }
  throw new Error(`未知 action：${action}`);
}

async function toolSessionStatus(args) {
  const sessionId = sessionIdOf(args);
  const owned = ownedBy(sessionId);
  if (owned.length === 0) return `会话 ${sessionId} 当前没有实例。先 list_and_bind_profile bind 或 session_attach。`;
  const rows = [];
  for (const instance of owned) {
    const info = await evaluate(instance.cdp, instance.pageSession, '({ url: location.href, title: document.title })').catch((error) => ({
      url: '',
      title: `读取失败：${error instanceof Error ? error.message : String(error)}`,
    }));
    rows.push({
      profile_id: instance.profileId,
      name: instance.name,
      session_id: instance.sessionId,
      target_id: instance.targetId,
      page_session: instance.pageSession,
      url: info?.url ?? '',
      title: info?.title ?? '',
      started_at: new Date(instance.startedAt).toISOString(),
    });
  }
  return JSON.stringify({ session_id: sessionId, count: rows.length, instances: rows }, null, 2);
}

async function toolSessionTabs(args) {
  const instance = requireInstance(args);
  const cdp = instance.cdp;
  const action = String(args.action ?? 'list');

  const listPages = async () => {
    const { targetInfos = [] } = await cdp.send('Target.getTargets', {});
    return targetInfos.filter((target) => target.type === 'page');
  };

  if (action === 'list') {
    const pages = await listPages();
    return JSON.stringify(pages.map((target, index) => ({
      index,
      target_id: target.targetId,
      url: target.url,
      title: target.title,
      active: target.targetId === instance.targetId,
    })), null, 2);
  }

  if (action === 'open') {
    const url = String(args.url ?? 'about:blank').trim() || 'about:blank';
    const { targetId } = await cdp.send('Target.createTarget', { url });
    instance.pageSession = await attachTarget(cdp, targetId);
    instance.targetId = targetId;
    await cdp.send('Target.activateTarget', { targetId }).catch(() => {});
    const info = await evaluate(cdp, instance.pageSession, '({ url: location.href, title: document.title })').catch(() => ({ url, title: '' }));
    return `已新建标签 ${targetId}\n${info.url}\n${info.title}`;
  }

  if (action === 'switch') {
    const pages = await listPages();
    const target = args.target_id
      ? pages.find((page) => page.targetId === String(args.target_id))
      : pages[Number(args.index)];
    if (!target) throw new Error(`没有这个标签：${args.target_id ?? args.index}`);
    instance.pageSession = await attachTarget(cdp, target.targetId);
    instance.targetId = target.targetId;
    await cdp.send('Target.activateTarget', { targetId: target.targetId }).catch(() => {});
    return `已切换 ${target.targetId}\n${target.url}\n${target.title}`;
  }

  if (action === 'close') {
    const pages = await listPages();
    const target = args.target_id
      ? pages.find((page) => page.targetId === String(args.target_id))
      : args.index !== undefined ? pages[Number(args.index)] : pages.find((page) => page.targetId === instance.targetId);
    if (!target) throw new Error('没有可关闭的标签');
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
    await sleep(300);
    const left = await listPages();
    const next = left.find((page) => page.url && !page.url.startsWith('chrome://')) ?? left[0];
    if (next) {
      instance.pageSession = await attachTarget(cdp, next.targetId);
      instance.targetId = next.targetId;
      return `已关闭 ${target.targetId}\n当前标签：${next.url}`;
    }
    throw new Error(`已关闭 ${target.targetId}，实例里没有剩余页面`);
  }

  throw new Error(`tabs 未知 action：${action}`);
}

async function toolSessionWait(args) {
  const instance = requireInstance(args);
  return JSON.stringify(await waitForPage(instance.cdp, instance.pageSession, args));
}

async function toolSessionSnapshot(args) {
  const instance = requireInstance(args);
  const snapshot = await pageSnapshot(instance.cdp, instance.pageSession, args);
  return JSON.stringify(snapshot, null, 2);
}

async function toolSessionScreenshot(args) {
  const instance = requireInstance(args);
  const { data } = await instance.cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: args.full_page === true,
  }, instance.pageSession, 30_000);
  return {
    content: [{ type: 'image', data, mimeType: 'image/png' }],
  };
}

async function toolExtract(args) {
  const instance = requireInstance(args);
  const mode = String(args.mode ?? 'markdown');
  const selector = args.selector ? String(args.selector) : '';
  return extractValue(instance.cdp, instance.pageSession, { selector, mode });
}

async function toolCookies(args) {
  const instance = requireInstance(args);
  const action = String(args.action ?? 'get');
  const cdp = instance.cdp;
  const sid = instance.pageSession;

  if (action === 'get') {
    const { cookies = [] } = await cdp.send('Storage.getCookies', {}, sid);
    return JSON.stringify(cookies, null, 2);
  }
  if (action === 'set') {
    let cookies;
    try {
      cookies = JSON.parse(String(args.cookies_json ?? '[]'));
    } catch {
      throw new Error('cookies_json 不是合法 JSON');
    }
    if (!Array.isArray(cookies)) throw new Error('cookies_json 必须是数组');
    await cdp.send('Network.setCookies', { cookies }, sid);
    return `已注入 ${cookies.length} 个 Cookie`;
  }
  if (action === 'clear') {
    await cdp.send('Network.clearBrowserCookies', {}, sid);
    return '已清空当前实例 Cookie';
  }
  throw new Error(`未知 action：${action}`);
}

async function toolStop(args) {
  const sessionId = sessionIdOf(args);
  const profileId = String(args.profile_id ?? '').trim();
  const released = await release(sessionId, profileId);
  if (released.length === 0) {
    return profileId
      ? `会话 ${sessionId} 没有接管 profile ${profileId}`
      : `会话 ${sessionId} 没有绑定实例`;
  }
  return `已关闭并释放：${released.join(', ')}（会话 ${sessionId}）`;
}

function formatState(state) {
  return JSON.stringify(
    {
      statePath: workspaceStatePath(),
      mappings: state.mappings,
      skills: state.skills,
      assignments: state.assignments,
      settings: state.settings,
    },
    null,
    2,
  );
}

async function toolWorkspaceState(args) {
  const action = String(args.action ?? 'get');
  if (action === 'get') return formatState(readWorkspaceState());

  if (action === 'mapping') {
    const profileId = String(args.profile_id ?? '').trim();
    const sessionId = String(args.session_id ?? '').trim();
    if (!profileId || !sessionId) throw new Error('action=mapping 需要 profile_id 与 session_id');
    const name = String(args.profile_name ?? '').trim() || (await profileName(profileId));
    const state = saveMapping(profileId, name, sessionId, String(args.source ?? 'mcp'));
    return formatState(state);
  }

  if (action === 'unmap') {
    const profileId = String(args.profile_id ?? '').trim();
    if (!profileId) throw new Error('action=unmap 需要 profile_id');
    const state = removeMapping(profileId, String(args.session_id ?? '').trim());
    return formatState(state);
  }

  if (action === 'settings') {
    const state = readWorkspaceState();
    if (args.launcher_path !== undefined) state.settings.launcher_path = String(args.launcher_path ?? '').trim();
    writeWorkspaceState(state);
    return formatState(state);
  }

  throw new Error(`未知 action：${action}`);
}

async function toolSkillList(args) {
  const state = readWorkspaceState();
  const query = String(args.query ?? '').trim().toLowerCase();
  const skills = state.skills.filter((skill) => {
    if (!query) return true;
    return [skill.name, skill.site, skill.url_pattern, skill.description, skill.id]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
  const profileId = String(args.profile_id ?? '').trim();
  const folder = String(args.folder ?? '').trim();
  return JSON.stringify(
    {
      count: skills.length,
      skills,
      assignments: state.assignments,
      effective: profileId || folder ? skillsForProfile(state, profileId, folder) : undefined,
    },
    null,
    2,
  );
}

async function toolSkillSave(args) {
  let input = args.skill && typeof args.skill === 'object' ? args.skill : args;
  if (typeof args.skill_json === 'string' && args.skill_json.trim()) {
    try {
      input = JSON.parse(args.skill_json);
    } catch (error) {
      throw new Error(`skill_json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Skill 名称不能为空');
  const state = readWorkspaceState();
  const requestedId = String(input.id ?? '').trim();
  const id = requestedId || `skill-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const existing = state.skills.find((skill) => skill.id === id) ?? null;
  const now = Date.now();
  const record = {
    id,
    name,
    site: String(input.site ?? '').trim(),
    url_pattern: String(input.url_pattern ?? '').trim(),
    description: String(input.description ?? '').trim(),
    steps: normalizeSteps(input.steps),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  state.skills = [...state.skills.filter((skill) => skill.id !== id), record];
  writeWorkspaceState(state);
  return JSON.stringify({ skill: record, statePath: workspaceStatePath() }, null, 2);
}

async function toolSkillAssign(args) {
  const skillId = String(args.skill_id ?? '').trim();
  const targetType = String(args.target_type ?? 'profile');
  const targetId = String(args.target_id ?? '').trim();
  if (!skillId) throw new Error('skill_assign 需要 skill_id');
  if (targetType !== 'profile' && targetType !== 'folder') throw new Error('target_type 只能是 profile 或 folder');
  if (!targetId) throw new Error('skill_assign 需要 target_id');
  const state = readWorkspaceState();
  if (!state.skills.some((skill) => skill.id === skillId)) throw new Error(`没有这个 Skill：${skillId}`);
  const remove = Boolean(args.remove);
  state.assignments = state.assignments.filter(
    (item) => !(item.skill_id === skillId && item.target_type === targetType && item.target_id === targetId),
  );
  if (!remove) {
    state.assignments.push({ skill_id: skillId, target_type: targetType, target_id: targetId, created_at: Date.now() });
  }
  writeWorkspaceState(state);
  return JSON.stringify(
    { removed: remove, assignments: state.assignments.filter((item) => item.skill_id === skillId) },
    null,
    2,
  );
}

async function toolSkillRun(args) {
  const skillId = String(args.skill_id ?? '').trim();
  if (!skillId) throw new Error('skill_run 需要 skill_id');
  const state = readWorkspaceState();
  const skill = state.skills.find((item) => item.id === skillId);
  if (!skill) throw new Error(`没有这个 Skill：${skillId}`);
  const instance = requireInstance(args);
  const results = await runSkillOnInstance(instance, skill.steps);
  const ok = results.every((step) => step.ok !== false);
  return JSON.stringify(
    {
      skill_id: skill.id,
      skill: skill.name,
      profile_id: instance.profileId,
      session_id: instance.sessionId,
      ok,
      steps: results,
    },
    null,
    2,
  );
}

async function toolServerStatus() {
  return JSON.stringify(await serverStatus(), null, 2);
}

async function toolServerControl(args) {
  const action = String(args.action ?? '').trim();
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    throw new Error('action 只能是 start / stop / restart');
  }
  const result = await controlServer(action, args.launcher_path);
  return JSON.stringify(result, null, 2);
}

async function toolServerSync(args) {
  const status = await serverStatus();
  const includeProfiles = args.include_profiles !== false;
  const [overview, proxies, running] = await Promise.all([
    foldersOverview({ includeProfiles: false }),
    api('GET', '/proxies').catch(() => []),
    api('GET', '/running').catch(() => []),
  ]);
  const profiles = includeProfiles ? asArray(await api('GET', '/profiles').catch(() => [])) : undefined;
  const proxyList = asArray(proxies);
  const runningList = asArray(running);
  return JSON.stringify(
    {
      syncedAt: Date.now(),
      version: status.version,
      port: status.port,
      dataRoot: status.dataRoot,
      folderCount: overview.count,
      folderSummary: overview.folders,
      profileCount: overview.totalProfiles,
      proxyCount: proxyList.length,
      runningCount: runningList.length,
      folders: overview.folders.map((item) => item.folder).filter(Boolean),
      proxies: proxyList,
      running: runningList,
      profiles,
    },
    null,
    2,
  );
}

const HANDLERS = {
  list_and_bind_profile: toolListAndBind,
  session_attach: toolSessionAttach,
  session_navigate: toolNavigate,
  session_interact: toolInteract,
  session_extract_dom: toolExtract,
  session_manage_cookies: toolCookies,
  session_stop_and_release: toolStop,
  session_status: toolSessionStatus,
  session_tabs: toolSessionTabs,
  session_wait: toolSessionWait,
  session_snapshot: toolSessionSnapshot,
  session_screenshot: toolSessionScreenshot,
  workspace_state: toolWorkspaceState,
  skill_list: toolSkillList,
  skill_save: toolSkillSave,
  skill_assign: toolSkillAssign,
  skill_run: toolSkillRun,
  folder_list: toolFolderList,
  folder_rename: toolFolderRename,
  folder_delete: toolFolderDelete,
  profile_get: toolProfileGet,
  profile_create: toolProfileCreate,
  profile_edit: toolProfileEdit,
  profile_delete: toolProfileDelete,
  proxy_list: toolProxyList,
  proxy_add: toolProxyAdd,
  proxy_delete: toolProxyDelete,
  fingerprint_new: toolFingerprintNew,
  fingerprint_list: toolFingerprintList,
  server_status: toolServerStatus,
  server_control: toolServerControl,
  server_sync: toolServerSync,
};

// ---------------------------------------------------------------------------
// MCP stdio protocol
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    if (!isNotification) reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      })),
    });
    return;
  }
  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const handler = HANDLERS[name];
    if (!handler) {
      replyError(id, -32602, `未知工具：${name}`);
      return;
    }
    try {
      const result = await handler(args);
      if (result && typeof result === 'object' && Array.isArray(result.content)) {
        reply(id, result);
      } else {
        reply(id, { content: [{ type: 'text', text: String(result) }] });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply(id, { content: [{ type: 'text', text: message }], isError: true });
    }
    return;
  }
  if (method === 'resources/list') {
    reply(id, { resources: [] });
    return;
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] });
    return;
  }
  if (!isNotification) replyError(id, -32601, `不支持的方法：${method}`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object' || !message.method) return;
  void handle(message).catch((error) => {
    const id = message.id;
    if (id !== undefined && id !== null) {
      replyError(id, -32603, error instanceof Error ? error.message : String(error));
    } else {
      process.stderr.write(`[shardx-mcp] ${error instanceof Error ? error.stack : String(error)}\n`);
    }
  });
});

function shutdown() {
  for (const instance of instances.values()) {
    try {
      instance.cdp.close();
    } catch {
      /* ignore */
    }
  }
  instances.clear();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
input.on('close', shutdown);
