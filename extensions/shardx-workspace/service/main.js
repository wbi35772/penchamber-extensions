// service/main.ts
import { createServer } from "node:http";
import { createHmac, randomBytes as randomBytes2 } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

// service/ws.ts
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
var HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var OPCODE_CONTINUATION = 0;
var OPCODE_TEXT = 1;
var OPCODE_BINARY = 2;
var OPCODE_CLOSE = 8;
var OPCODE_PING = 9;
var OPCODE_PONG = 10;
function frame(opcode, payload) {
  const length = payload.length;
  let headerLength = 2;
  if (length >= 126 && length <= 65535)
    headerLength += 2;
  else if (length > 65535)
    headerLength += 8;
  const header = Buffer.alloc(headerLength + 4);
  header[0] = 128 | opcode;
  let offset = 2;
  if (length < 126) {
    header[1] = 128 | length;
  } else if (length <= 65535) {
    header[1] = 128 | 126;
    header.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    header[1] = 128 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }
  const mask = randomBytes(4);
  mask.copy(header, offset);
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0;index < length; index += 1) {
    masked[index] = payload[index] ^ mask[index & 3];
  }
  return Buffer.concat([header, masked]);
}

class MiniWebSocket {
  socket = null;
  buffer = Buffer.alloc(0);
  fragments = [];
  fragmentOpcode = 0;
  closed = false;
  closeReason = "";
  heartbeat = null;
  handlers;
  constructor(handlers) {
    this.handlers = handlers;
  }
  static connect(url, handlers, options = {}) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        reject(new Error(`CDP 地址无效: ${url}`));
        return;
      }
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        reject(new Error(`CDP 地址必须是 ws:// 或 wss://: ${url}`));
        return;
      }
      const secure = parsed.protocol === "wss:";
      const key = randomBytes(16).toString("base64");
      const timeoutMs = options.timeoutMs ?? 15000;
      let settled = false;
      const settle = (error, value) => {
        if (settled)
          return;
        settled = true;
        if (error)
          reject(error);
        else
          resolve(value);
      };
      const request = (secure ? httpsRequest : httpRequest)({
        hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
        port: parsed.port || (secure ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          ...options.headers ?? {},
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13"
        },
        timeout: timeoutMs
      });
      request.on("upgrade", (response, socket, head) => {
        const expected = createHash("sha1").update(`${key}${HANDSHAKE_GUID}`).digest("base64");
        if (response.headers["sec-websocket-accept"] !== expected) {
          socket.destroy();
          settle(new Error("CDP WebSocket 握手校验失败"));
          return;
        }
        const ws = new MiniWebSocket(handlers);
        ws.socket = socket;
        socket.setNoDelay(true);
        if (head && head.length > 0)
          ws.ingest(head);
        socket.on("data", (chunk) => ws.ingest(chunk));
        socket.on("close", () => ws.fail("CDP WebSocket 连接已关闭"));
        socket.on("error", (error) => ws.fail(`CDP WebSocket 错误: ${error?.message ?? error}`));
        ws.startHeartbeat(options.heartbeatMs ?? 20000);
        settle(undefined, ws);
      });
      request.on("response", (response) => {
        response.resume();
        settle(new Error(`CDP WebSocket 被拒绝（HTTP ${response.statusCode}）`));
      });
      request.on("error", (error) => settle(new Error(`CDP WebSocket 连接失败: ${error?.message ?? error}`)));
      request.on("timeout", () => {
        request.destroy();
        settle(new Error(`CDP WebSocket 连接超时（${Math.round(timeoutMs / 1000)}s）`));
      });
      request.end();
    });
  }
  isOpen() {
    return !this.closed && this.socket !== null;
  }
  send(text) {
    if (!this.isOpen())
      throw new Error(this.closeReason || "CDP 连接已关闭");
    this.socket.write(frame(OPCODE_TEXT, Buffer.from(text, "utf8")));
  }
  close(reason = "客户端关闭") {
    if (this.closed)
      return;
    try {
      if (this.socket) {
        this.socket.write(frame(OPCODE_CLOSE, Buffer.alloc(0)));
      }
    } catch {}
    this.fail(reason);
    try {
      this.socket?.end();
    } catch {}
  }
  startHeartbeat(intervalMs) {
    if (intervalMs <= 0)
      return;
    this.heartbeat = setInterval(() => {
      if (!this.isOpen())
        return;
      try {
        this.socket.write(frame(OPCODE_PING, Buffer.alloc(0)));
      } catch {
        this.fail("CDP 心跳失败");
      }
    }, intervalMs);
    this.heartbeat.unref?.();
  }
  fail(reason) {
    if (this.closed)
      return;
    this.closed = true;
    this.closeReason = reason;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try {
      this.socket?.destroy();
    } catch {}
    this.socket = null;
    try {
      this.handlers.onClose?.(reason);
    } catch {}
  }
  ingest(chunk) {
    if (this.closed)
      return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.parseFrame()) {
      if (this.closed)
        return;
    }
  }
  parseFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2)
      return false;
    const first = buffer[0];
    const second = buffer[1];
    const fin = (first & 128) !== 0;
    const opcode = first & 15;
    const masked = (second & 128) !== 0;
    let length = second & 127;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2)
        return false;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8)
        return false;
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(64 * 1024 * 1024)) {
        this.fail("CDP 消息超过 64MB 上限");
        return false;
      }
      length = Number(big);
      offset += 8;
    }
    let mask = null;
    if (masked) {
      if (buffer.length < offset + 4)
        return false;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buffer.length < offset + length)
      return false;
    let payload = buffer.subarray(offset, offset + length);
    this.buffer = buffer.subarray(offset + length);
    if (mask) {
      const unmasked = Buffer.allocUnsafe(length);
      for (let index = 0;index < length; index += 1) {
        unmasked[index] = payload[index] ^ mask[index & 3];
      }
      payload = unmasked;
    }
    if (opcode === OPCODE_PING) {
      try {
        this.socket?.write(frame(OPCODE_PONG, payload));
      } catch {
        this.fail("CDP Pong 发送失败");
      }
      return true;
    }
    if (opcode === OPCODE_PONG)
      return true;
    if (opcode === OPCODE_CLOSE) {
      let reason = "CDP 对端关闭连接";
      if (payload.length >= 2) {
        const code = payload.readUInt16BE(0);
        const text = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        reason = `CDP 连接已关闭（code ${code}${text ? `: ${text}` : ""}）`;
      }
      try {
        this.socket?.write(frame(OPCODE_CLOSE, Buffer.alloc(0)));
      } catch {}
      this.fail(reason);
      return false;
    }
    if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    } else if (opcode === OPCODE_CONTINUATION) {
      this.fragments.push(payload);
    } else {
      return true;
    }
    if (!fin)
      return true;
    const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === OPCODE_TEXT) {
      try {
        this.handlers.onMessage?.(whole.toString("utf8"));
      } catch {}
    }
    return true;
  }
}

// service/main.ts
var execFileAsync = promisify(execFile);
var BODY_MAX = 1024 * 1024;
var EVENT_MAX = 4000;
var EVENT_BYTES_MAX = 4 * 1024 * 1024;
var SESSION_IDLE_MS = 120000;
var PROXY_TIMEOUT_MS = 15000;
var PROXY_BODY_MAX = 7000000;

class BodyTooLargeError extends Error {
}
function parsePort(raw) {
  const value = (raw ?? "").trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`OPENCHAMBER_SERVICE_PORT must be an integer port, got ${JSON.stringify(raw ?? "")}.`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(`OPENCHAMBER_SERVICE_PORT must be between 1 and 65535, got ${port}.`);
  }
  return port;
}
var PORT = (() => {
  try {
    return parsePort(process.env.OPENCHAMBER_SERVICE_PORT);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exit(1);
    return 0;
  }
})();
var TOKEN = String(process.env.OPENCHAMBER_SERVICE_TOKEN ?? "").trim();
if (!TOKEN) {
  process.stderr.write(`OPENCHAMBER_SERVICE_TOKEN is missing.
`);
  process.exit(1);
}
var sessions = new Map;
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_MAX)
      throw new BodyTooLargeError;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim())
    return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return parsed;
}
function isLoopbackHost(host) {
  const clean = host.replace(/^\[|\]$/g, "").toLowerCase();
  return clean === "127.0.0.1" || clean === "localhost" || clean === "::1";
}
function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
function wake(session) {
  const waiters = [...session.waiters];
  session.waiters.clear();
  for (const waiter of waiters) {
    try {
      waiter();
    } catch {}
  }
}
function pushEvent(session, message) {
  session.events.push(message);
  session.eventBytes += JSON.stringify(message).length;
  while (session.events.length > EVENT_MAX || session.eventBytes > EVENT_BYTES_MAX) {
    const removed = session.events.shift();
    if (removed === undefined)
      break;
    session.eventBytes -= JSON.stringify(removed).length;
    session.gap = true;
  }
  if (session.eventBytes < 0)
    session.eventBytes = 0;
  wake(session);
}
function findSession(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id)
    return null;
  return sessions.get(id) ?? null;
}
var WORKSPACE_VERSION = 1;
function workspaceStatePath() {
  const override = String(process.env.SHARDX_WORKSPACE_STATE ?? "").trim();
  if (override)
    return override;
  const appData = String(process.env.APPDATA ?? "").trim();
  if (appData)
    return join(appData, "shardx-workspace", "state.json");
  const profile = String(process.env.USERPROFILE ?? "").trim();
  if (profile)
    return join(profile, "AppData", "Roaming", "shardx-workspace", "state.json");
  return join(process.cwd(), ".shardx-workspace", "state.json");
}
function emptyWorkspaceState() {
  return { version: WORKSPACE_VERSION, mappings: [], skills: [], assignments: [], settings: { launcher_path: "" } };
}
function text(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}
function stamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : Date.now();
}
function normalizeSteps(raw) {
  if (!Array.isArray(raw))
    return [];
  const steps = [];
  for (const item of raw.slice(0, 200)) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      continue;
    const action = text(item.action, 40);
    if (!action)
      continue;
    steps.push({ ...item, action });
  }
  return steps;
}
function normalizeWorkspaceState(raw) {
  const state = emptyWorkspaceState();
  if (!raw || typeof raw !== "object")
    return state;
  const mappings = new Map;
  for (const item of Array.isArray(raw.mappings) ? raw.mappings.slice(0, 5000) : []) {
    if (!item || typeof item !== "object")
      continue;
    const profileId = text(item.profile_id, 200);
    const sessionId = text(item.session_id, 200);
    if (!profileId || !sessionId)
      continue;
    mappings.set(profileId, {
      profile_id: profileId,
      profile_name: text(item.profile_name, 200) || profileId,
      session_id: sessionId,
      source: text(item.source, 40) || "panel",
      updated_at: stamp(item.updated_at)
    });
  }
  state.mappings = [...mappings.values()];
  const skills = new Map;
  for (const item of Array.isArray(raw.skills) ? raw.skills.slice(0, 1000) : []) {
    if (!item || typeof item !== "object")
      continue;
    const name = text(item.name, 200);
    if (!name)
      continue;
    const id = text(item.id, 120) || `skill-${Date.now().toString(36)}-${randomBytes2(3).toString("hex")}`;
    const createdAt = stamp(item.created_at);
    skills.set(id, {
      id,
      name,
      site: text(item.site, 300),
      url_pattern: text(item.url_pattern, 1000),
      description: text(item.description, 4000),
      steps: normalizeSteps(item.steps),
      created_at: createdAt,
      updated_at: stamp(item.updated_at)
    });
  }
  state.skills = [...skills.values()];
  const assignments = new Map;
  for (const item of Array.isArray(raw.assignments) ? raw.assignments.slice(0, 1e4) : []) {
    if (!item || typeof item !== "object")
      continue;
    const skillId = text(item.skill_id, 120);
    const targetId = text(item.target_id, 200);
    const targetType = item.target_type === "folder" ? "folder" : "profile";
    if (!skillId || !targetId)
      continue;
    const key = `${skillId}|${targetType}|${targetId}`;
    assignments.set(key, {
      skill_id: skillId,
      target_type: targetType,
      target_id: targetId,
      created_at: stamp(item.created_at)
    });
  }
  state.assignments = [...assignments.values()];
  if (raw.settings && typeof raw.settings === "object") {
    state.settings.launcher_path = text(raw.settings.launcher_path, 2000);
  }
  return state;
}
function readWorkspaceState() {
  try {
    return normalizeWorkspaceState(JSON.parse(readFileSync(workspaceStatePath(), "utf8")));
  } catch {
    return emptyWorkspaceState();
  }
}
function writeWorkspaceState(state) {
  const normalized = normalizeWorkspaceState(state);
  const path = workspaceStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(normalized, null, 2), "utf8");
  try {
    renameSync(temp, path);
  } catch {
    writeFileSync(path, JSON.stringify(normalized, null, 2), "utf8");
  }
  return normalized;
}
async function handleProxy(body) {
  const baseRaw = String(body.baseUrl ?? "").trim();
  let base;
  try {
    base = new URL(baseRaw);
  } catch {
    return { status: 400, payload: { error: "baseUrl 无效", code: "BAD_BASE_URL" } };
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return { status: 400, payload: { error: "只允许 http/https", code: "BAD_BASE_URL" } };
  }
  if (!isLoopbackHost(base.hostname)) {
    return { status: 400, payload: { error: "只允许代理到本机回环地址", code: "BAD_BASE_URL" } };
  }
  const path = String(body.path ?? "");
  if (!path.startsWith("/") || path.includes("\x00") || path.includes("..")) {
    return { status: 400, payload: { error: "path 无效", code: "BAD_PATH" } };
  }
  let target;
  try {
    target = new URL(path, base.origin);
  } catch {
    return { status: 400, payload: { error: "path 无效", code: "BAD_PATH" } };
  }
  const query = body.query;
  if (query && typeof query === "object" && !Array.isArray(query)) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        target.searchParams.set(key, String(value));
      }
    }
  }
  const headers = { Accept: "application/json" };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token)
    headers.Authorization = `Bearer ${token}`;
  const payloadBody = body.body;
  const hasBody = payloadBody !== undefined && payloadBody !== null;
  if (hasBody)
    headers["Content-Type"] = "application/json";
  const init = {
    method: String(body.method ?? "GET").toUpperCase(),
    headers,
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS)
  };
  if (hasBody)
    init.body = JSON.stringify(payloadBody);
  let response;
  try {
    response = await fetch(target.toString(), init);
  } catch (error) {
    return {
      status: 502,
      payload: {
        error: `无法连接 ShardX 本地 API（${target.origin}）`,
        code: "NETWORK",
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    return {
      status: 502,
      payload: { error: "读取 ShardX 响应失败", code: "NETWORK", detail: String(error) }
    };
  }
  const truncated = text.length > PROXY_BODY_MAX;
  return {
    status: 200,
    payload: {
      status: response.status,
      body: truncated ? text.slice(0, PROXY_BODY_MAX) : text,
      truncated,
      contentType: response.headers.get("content-type")
    }
  };
}
function shardxSettingsPath() {
  const override = String(process.env.SHARDX_LAUNCHER_SETTINGS ?? "").trim();
  if (override)
    return override;
  const appData = String(process.env.APPDATA ?? "").trim();
  return appData ? `${appData}\\shardx-launcher\\settings.json` : "";
}
function base64url(input) {
  return Buffer.from(input).toString("base64url");
}
function mintLauncherToken(secret, ttlSeconds = 31536000) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ sub: "shardx-api", iat: now, exp: now + ttlSeconds }));
  const signature = createHmac("sha256", Buffer.from(secret, "utf8")).update(`${header}.${claims}`).digest("base64url");
  return `${header}.${claims}.${signature}`;
}
async function handleDiscover() {
  const path = shardxSettingsPath();
  if (!path) {
    return { status: 200, payload: { found: false, reason: "APPDATA 不可用，无法定位 ShardX 配置" } };
  }
  let settings;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      status: 200,
      payload: {
        found: false,
        reason: `读取 ShardX 配置失败：${path}`,
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }
  const port = Number(settings.api_port);
  const secret = String(settings.api_secret ?? "").trim();
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { status: 200, payload: { found: false, reason: "ShardX 配置中没有有效的 api_port", settingsPath: path } };
  }
  if (!secret) {
    return { status: 200, payload: { found: false, reason: "ShardX 尚未生成 api_secret，请先在客户端启用自动化 API", settingsPath: path } };
  }
  let version = "";
  let running = false;
  try {
    const response = await fetch(`http://127.0.0.1:${Math.trunc(port)}/health`, {
      signal: AbortSignal.timeout(3000)
    });
    running = response.ok;
    if (response.ok) {
      const health = await response.json();
      version = String(health.version ?? "");
    }
  } catch {
    running = false;
  }
  return {
    status: 200,
    payload: {
      found: true,
      running,
      port: Math.trunc(port),
      token: mintLauncherToken(secret),
      version,
      apiEnabled: settings.api_enabled !== false,
      dataRoot: String(settings.data_root ?? ""),
      settingsPath: path
    }
  };
}
async function handleWorkspaceStateRoute() {
  return {
    status: 200,
    payload: { state: readWorkspaceState(), statePath: workspaceStatePath() }
  };
}
function splitArgs(raw) {
  const out = [];
  let current = "";
  let quote = "";
  for (const ch of raw) {
    if (quote) {
      if (ch === quote)
        quote = "";
      else
        current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current)
    out.push(current);
  return out;
}
function ensureLauncherDebugArgs() {
  const settingsPath = shardxSettingsPath();
  if (!settingsPath)
    return { changed: false, extraArgs: "", settingsPath, error: "APPDATA 不可用" };
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    return {
      changed: false,
      extraArgs: "",
      settingsPath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  const args = splitArgs(String(settings.extra_args ?? ""));
  let changed = false;
  if (!args.some((arg) => arg === "--remote-allow-origins=*")) {
    args.push("--remote-allow-origins=*");
    changed = true;
  }
  if (!args.some((arg) => arg === "--remote-debugging-port" || arg.startsWith("--remote-debugging-port="))) {
    args.unshift("--remote-debugging-port=0");
    changed = true;
  }
  const extraArgs = args.join(" ");
  if (changed) {
    settings.extra_args = extraArgs;
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      const temp = `${settingsPath}.tmp-${randomBytes2(4).toString("hex")}`;
      writeFileSync(temp, `${JSON.stringify(settings, null, 2)}
`, "utf8");
      renameSync(temp, settingsPath);
    } catch (error) {
      return {
        changed: false,
        extraArgs,
        settingsPath,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return { changed, extraArgs, settingsPath };
}
function readDevToolsActivePort(dataRoot, profileId) {
  if (!dataRoot || !profileId)
    return null;
  const file = join(dataRoot, "user-data", profileId, "DevToolsActivePort");
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const port = Number(lines[0]);
    const path = lines[1] ?? "";
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return null;
    if (!path.startsWith("/devtools/"))
      return null;
    return { port, path };
  } catch {
    return null;
  }
}
async function handleInstancesRunning() {
  const discovered = await handleDiscover();
  const data = discovered.payload ?? {};
  if (!data.found)
    return { status: 200, payload: { ...data, profiles: [] } };
  if (!data.running) {
    return { status: 409, payload: { ...data, code: "NOT_RUNNING", error: "ShardX 未运行", profiles: [] } };
  }
  const base = `http://127.0.0.1:${Math.trunc(Number(data.port) || 40325)}`;
  const headers = { authorization: `Bearer ${String(data.token ?? "")}` };
  let raw;
  try {
    const response = await fetch(`${base}/running`, { headers, signal: AbortSignal.timeout(6000) });
    if (!response.ok) {
      return { status: 502, payload: { error: `/running 返回 HTTP ${response.status}`, profiles: [] } };
    }
    raw = await response.json();
  } catch (error) {
    return {
      status: 502,
      payload: { error: error instanceof Error ? error.message : String(error), profiles: [] }
    };
  }
  const list = asArray(raw);
  const dataRoot = String(data.dataRoot ?? "");
  let enriched = 0;
  const profiles = list.map((item) => {
    if (!item || typeof item !== "object")
      return item;
    const profileId = text(item.profile_id ?? item.profileId ?? item.id, 200);
    if (!profileId)
      return item;
    const cdp = item.cdp && typeof item.cdp === "object" ? item.cdp : {};
    const hasWs = Boolean(cdp.web_socket_debugger_url || cdp.webSocketDebuggerUrl || item.web_socket_debugger_url);
    if (hasWs)
      return { ...item, profile_id: profileId };
    const active = readDevToolsActivePort(dataRoot, profileId);
    if (!active)
      return { ...item, profile_id: profileId, cdp };
    enriched += 1;
    return {
      ...item,
      profile_id: profileId,
      cdp: {
        port: active.port,
        http_url: `http://127.0.0.1:${active.port}`,
        web_socket_debugger_url: `ws://127.0.0.1:${active.port}${active.path}`
      }
    };
  });
  return {
    status: 200,
    payload: {
      profiles,
      enriched,
      dataRoot,
      port: data.port,
      attachable: profiles.filter((item) => Boolean(item?.cdp?.web_socket_debugger_url)).length,
      source: "/instances/running"
    }
  };
}
async function handleLauncherSettings(body) {
  const ensure = body.ensure_debug === true;
  const result = ensure ? ensureLauncherDebugArgs() : (() => {
    const settingsPath = shardxSettingsPath();
    let extraArgs = "";
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      extraArgs = String(settings.extra_args ?? "");
    } catch {
      extraArgs = "";
    }
    return { changed: false, extraArgs, settingsPath, error: undefined };
  })();
  return {
    status: result.error ? 500 : 200,
    payload: {
      ...result,
      debugEnabled: result.extraArgs.includes("--remote-debugging-port") && result.extraArgs.includes("--remote-allow-origins=*")
    }
  };
}
async function handleMapping(body) {
  const profileId = text(body.profile_id, 200);
  if (!profileId)
    return { status: 400, payload: { error: "profile_id 不能为空", code: "BAD_PROFILE" } };
  const state = readWorkspaceState();
  const sessionId = text(body.session_id, 200);
  state.mappings = state.mappings.filter((item) => item.profile_id !== profileId);
  if (sessionId) {
    state.mappings.push({
      profile_id: profileId,
      profile_name: text(body.profile_name, 200) || profileId,
      session_id: sessionId,
      source: text(body.source, 40) || "panel",
      updated_at: Date.now()
    });
  }
  return { status: 200, payload: { state: writeWorkspaceState(state), statePath: workspaceStatePath() } };
}
async function handleSkillSave(body) {
  const input = body.skill && typeof body.skill === "object" ? body.skill : body;
  const name = text(input.name, 200);
  if (!name)
    return { status: 400, payload: { error: "Skill 名称不能为空", code: "BAD_SKILL" } };
  const state = readWorkspaceState();
  const id = text(input.id, 120) || `skill-${Date.now().toString(36)}-${randomBytes2(3).toString("hex")}`;
  const existing = state.skills.find((item) => item.id === id);
  const now = Date.now();
  const record = {
    id,
    name,
    site: text(input.site, 300),
    url_pattern: text(input.url_pattern, 1000),
    description: text(input.description, 4000),
    steps: normalizeSteps(input.steps),
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  state.skills = [...state.skills.filter((item) => item.id !== id), record];
  return { status: 200, payload: { skill: record, state: writeWorkspaceState(state) } };
}
async function handleSkillRemove(body) {
  const id = text(body.id, 120);
  if (!id)
    return { status: 400, payload: { error: "id 不能为空", code: "BAD_SKILL" } };
  const state = readWorkspaceState();
  state.skills = state.skills.filter((item) => item.id !== id);
  state.assignments = state.assignments.filter((item) => item.skill_id !== id);
  return { status: 200, payload: { removed: true, state: writeWorkspaceState(state) } };
}
async function handleAssign(body) {
  const skillId = text(body.skill_id, 120);
  const targetType = body.target_type === "folder" ? "folder" : "profile";
  const targetId = text(body.target_id ?? body.profile_id, 200);
  if (!skillId)
    return { status: 400, payload: { error: "skill_id 不能为空", code: "BAD_ASSIGN" } };
  const state = readWorkspaceState();
  if (!targetId) {
    state.assignments = state.assignments.filter((item) => item.skill_id !== skillId);
    return { status: 200, payload: { removed: true, state: writeWorkspaceState(state) } };
  }
  if (!state.skills.some((item) => item.id === skillId)) {
    return { status: 404, payload: { error: `Skill ${skillId} 不存在`, code: "NO_SKILL" } };
  }
  state.assignments = state.assignments.filter((item) => !(item.skill_id === skillId && item.target_type === targetType && item.target_id === targetId));
  if (body.remove !== true) {
    state.assignments.push({ skill_id: skillId, target_type: targetType, target_id: targetId, created_at: Date.now() });
  }
  return { status: 200, payload: { state: writeWorkspaceState(state) } };
}
async function handleWorkspaceSettings(body) {
  const state = readWorkspaceState();
  const settings = body.settings && typeof body.settings === "object" ? body.settings : body;
  if ("launcher_path" in settings)
    state.settings.launcher_path = text(settings.launcher_path, 2000);
  return { status: 200, payload: { state: writeWorkspaceState(state) } };
}
function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
async function listLauncherProcesses(pathHint = "") {
  const filter = pathHint ? `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${psQuote(pathHint)} }` : `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'ShardBrowser*' }`;
  const script = `${filter} | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 8000, windowsHide: true });
    const raw = String(stdout ?? "").trim();
    if (!raw)
      return [];
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const result = [];
    for (const row of rows) {
      const pid = Number(row?.ProcessId);
      const path = String(row?.ExecutablePath ?? "").trim();
      if (Number.isFinite(pid) && pid > 0)
        result.push({ pid: Math.trunc(pid), path });
    }
    return result;
  } catch {
    return [];
  }
}
function launcherCandidates() {
  const out = [];
  const envPath = String(process.env.SHARDX_LAUNCHER_PATH ?? "").trim();
  if (envPath)
    out.push(envPath);
  const local = String(process.env.LOCALAPPDATA ?? "").trim();
  const roaming = String(process.env.APPDATA ?? "").trim();
  const programFiles = String(process.env.ProgramFiles ?? "").trim();
  const programFiles86 = String(process.env["ProgramFiles(x86)"] ?? "").trim();
  if (local) {
    out.push(join(local, "Programs", "ShardBrowser", "ShardBrowser-Launcher.exe"));
    out.push(join(local, "Programs", "ShardBrowser-Launcher", "ShardBrowser-Launcher.exe"));
    out.push(join(local, "Programs", "shardx", "ShardBrowser-Launcher.exe"));
    out.push(join(local, "ShardX", "ShardBrowser-Launcher.exe"));
  }
  if (roaming)
    out.push(join(roaming, "ShardBrowser", "ShardBrowser-Launcher.exe"));
  if (programFiles)
    out.push(join(programFiles, "ShardBrowser", "ShardBrowser-Launcher.exe"));
  if (programFiles86)
    out.push(join(programFiles86, "ShardBrowser", "ShardBrowser-Launcher.exe"));
  return out;
}
function resolveLauncherPath(pathHint, processes = []) {
  const hint = String(pathHint ?? "").trim();
  if (hint)
    return hint;
  for (const item of processes) {
    if (item.path)
      return item.path;
  }
  for (const candidate of launcherCandidates()) {
    if (candidate && existsSync(candidate))
      return candidate;
  }
  return "";
}
function persistLauncherPath(path) {
  const clean = String(path ?? "").trim();
  if (!clean)
    return;
  try {
    const state = readWorkspaceState();
    if (state.settings.launcher_path === clean)
      return;
    state.settings.launcher_path = clean;
    writeWorkspaceState(state);
  } catch {}
}
async function killPid(pid) {
  try {
    process.kill(pid);
    return;
  } catch {}
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      timeout: 6000,
      windowsHide: true
    });
  } catch {}
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitForHealth(port, wantRunning, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let running = false;
    try {
      const response = await fetch(`http://127.0.0.1:${Math.trunc(port)}/health`, {
        signal: AbortSignal.timeout(2500)
      });
      running = response.ok;
    } catch {
      running = false;
    }
    if (running === wantRunning)
      return true;
    await sleep(500);
  }
  return false;
}
function mirrorPort() {
  const raw = Number(process.env.SHARDX_MIRROR_PORT);
  return Number.isFinite(raw) && raw >= 1 && raw <= 65535 ? Math.trunc(raw) : 40326;
}
function mirrorBrowserArgs() {
  const existing = String(process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? "").trim();
  if (existing.includes("--remote-debugging-port"))
    return existing;
  const args = `--remote-debugging-port=${mirrorPort()} --remote-allow-origins=*`;
  return existing ? `${existing} ${args}` : args;
}
function mirrorCandidatePorts() {
  const ports = new Set;
  const explicit = Number(process.env.SHARDX_MIRROR_PORT);
  if (Number.isFinite(explicit) && explicit > 0)
    ports.add(Math.trunc(explicit));
  const extra = String(process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? "");
  for (const match of extra.matchAll(/--remote-debugging-port=(\d+)/g)) {
    const port = Number(match[1]);
    if (Number.isFinite(port) && port > 0)
      ports.add(Math.trunc(port));
  }
  ports.add(40326);
  ports.add(9333);
  ports.add(9222);
  ports.add(9223);
  return [...ports];
}
async function probeMirrorPort(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${Math.trunc(port)}/json/list`, {
      signal: AbortSignal.timeout(1200)
    });
    if (!response.ok)
      return null;
    const raw = await response.json().catch(() => null);
    if (!Array.isArray(raw))
      return null;
    const targets = [];
    for (const item of raw) {
      const candidate = item;
      if (String(candidate.type ?? "") !== "page")
        continue;
      const webSocketDebuggerUrl = String(candidate.webSocketDebuggerUrl ?? "").trim();
      if (!webSocketDebuggerUrl)
        continue;
      targets.push({
        id: String(candidate.id ?? ""),
        title: String(candidate.title ?? ""),
        url: String(candidate.url ?? ""),
        webSocketDebuggerUrl
      });
    }
    return targets.length > 0 ? { port: Math.trunc(port), targets } : null;
  } catch {
    return null;
  }
}
async function handleLauncherStatus() {
  const ports = mirrorCandidatePorts();
  const results = await Promise.all(ports.map((port) => probeMirrorPort(port)));
  const hit = results.find((item) => item !== null);
  if (hit) {
    return {
      status: 200,
      payload: {
        found: true,
        cdpPort: hit.port,
        targets: hit.targets,
        ports,
        injectedArguments: mirrorBrowserArgs()
      }
    };
  }
  return {
    status: 200,
    payload: {
      found: false,
      cdpPort: null,
      targets: [],
      ports,
      injectedArguments: mirrorBrowserArgs(),
      hint: "ShardX 启动器当前没有开放 WebView2 调试端口。点击「重启并启用镜像」由扩展带调试参数重新拉起启动器。"
    }
  };
}
async function handleServerStatus() {
  const discovered = await handleDiscover();
  const data = discovered.payload ?? {};
  const state = readWorkspaceState();
  let launcherPath = state.settings.launcher_path;
  const processes = await listLauncherProcesses();
  if (!launcherPath) {
    launcherPath = resolveLauncherPath("", processes);
    if (launcherPath)
      persistLauncherPath(launcherPath);
  }
  const mirror = await handleLauncherStatus();
  return {
    status: 200,
    payload: {
      ...data,
      launcherPath,
      processes,
      statePath: workspaceStatePath(),
      mirror: mirror.payload
    }
  };
}
async function handleServerControl(body) {
  const action = text(body.action, 20).toLowerCase();
  if (!["start", "stop", "restart"].includes(action)) {
    return { status: 400, payload: { error: "action 必须是 start / stop / restart", code: "BAD_ACTION" } };
  }
  const state = readWorkspaceState();
  const discovered = await handleDiscover();
  const port = Number(discovered.payload?.port) || 40325;
  const pathHint = text(body.launcher_path, 2000) || text(body.path, 2000) || state.settings.launcher_path;
  if (action === "stop" || action === "restart") {
    const processes = await listLauncherProcesses(pathHint);
    for (const item of processes)
      await killPid(item.pid);
    if (processes.length > 0)
      await waitForHealth(port, false, 8000);
  }
  if (action === "start" || action === "restart") {
    const already = await waitForHealth(port, true, 1200);
    if (!already) {
      const processes = await listLauncherProcesses(pathHint);
      let launcherPath = resolveLauncherPath(pathHint || state.settings.launcher_path, processes);
      if (!launcherPath) {
        return {
          status: 400,
          payload: {
            error: "没有找到 ShardX 启动器路径，请在服务器管理里填写 launcher 的完整路径",
            code: "NEED_LAUNCHER_PATH",
            processes,
            statePath: workspaceStatePath()
          }
        };
      }
      try {
        persistLauncherPath(launcherPath);
        ensureLauncherDebugArgs();
        const child = spawn(launcherPath, [], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
          env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: mirrorBrowserArgs() }
        });
        child.unref();
      } catch (error) {
        return {
          status: 500,
          payload: {
            error: `启动 ShardX 失败：${error instanceof Error ? error.message : String(error)}`,
            code: "SPAWN_FAILED"
          }
        };
      }
      const started = await waitForHealth(port, true, 20000);
      if (!started) {
        return {
          status: 502,
          payload: {
            error: "启动命令已发出，但 20 秒内没有等到 /health，请检查启动器是否被系统拦截",
            code: "START_TIMEOUT",
            launcherPath
          }
        };
      }
    }
  }
  const after = await handleDiscover();
  const processes = await listLauncherProcesses(pathHint);
  const mirror = await handleLauncherStatus();
  return {
    status: 200,
    payload: {
      action,
      ...after.payload,
      launcherPath: pathHint || processes[0]?.path || "",
      processes,
      mirror: mirror.payload
    }
  };
}
function asArray(value) {
  if (Array.isArray(value))
    return value;
  if (value && typeof value === "object") {
    const record = value;
    for (const key of ["items", "data", "list", "profiles", "folders", "proxies", "running"]) {
      if (Array.isArray(record[key]))
        return record[key];
    }
  }
  return [];
}
async function handleServerSync() {
  const discovered = await handleDiscover();
  const data = discovered.payload ?? {};
  if (!data.found)
    return { status: 400, payload: { ...data, code: "NO_SETTINGS" } };
  if (!data.running)
    return { status: 409, payload: { ...data, code: "NOT_RUNNING", error: "ShardX 未运行，无法同步" } };
  const base = `http://127.0.0.1:${Math.trunc(Number(data.port) || 40325)}`;
  const headers = { authorization: `Bearer ${String(data.token ?? "")}` };
  const get = async (path) => {
    const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(1e4) });
    if (!response.ok)
      throw new Error(`${path} 返回 HTTP ${response.status}`);
    return response.json();
  };
  try {
    const [profiles, folders, proxies, running] = await Promise.all([
      get("/profiles"),
      get("/folders"),
      get("/proxies"),
      get("/running")
    ]);
    const profileList = asArray(profiles);
    const folderRows = asArray(folders);
    const proxyList = asArray(proxies);
    const runningList = asArray(running);
    return {
      status: 200,
      payload: {
        version: data.version,
        port: data.port,
        dataRoot: data.dataRoot,
        syncedAt: Date.now(),
        profiles: profileList,
        profileCount: profileList.length,
        folders: folderRows,
        folderCount: folderRows.length,
        proxies: proxyList,
        proxyCount: proxyList.length,
        running: runningList,
        runningCount: runningList.length
      }
    };
  } catch (error) {
    return {
      status: 502,
      payload: { error: `同步 ShardX 数据失败：${error instanceof Error ? error.message : String(error)}`, code: "SYNC_FAILED" }
    };
  }
}
async function handleOpen(body) {
  const url = String(body.url ?? "").trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 400, payload: { error: "CDP 地址无效", code: "BAD_URL" } };
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return { status: 400, payload: { error: "CDP 地址必须是 ws:// 或 wss://", code: "BAD_URL" } };
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { status: 400, payload: { error: "CDP 只允许连接本机回环地址", code: "BAD_URL" } };
  }
  const headers = body.headers && typeof body.headers === "object" && !Array.isArray(body.headers) ? body.headers : undefined;
  const timeoutMs = clampNumber(body.timeoutMs, 3000, 30000, 15000);
  const sessionId = randomBytes2(9).toString("hex");
  const session = {
    id: sessionId,
    url,
    ws: null,
    events: [],
    eventBytes: 0,
    gap: false,
    closed: false,
    reason: "",
    waiters: new Set,
    lastPoll: Date.now(),
    createdAt: Date.now()
  };
  sessions.set(sessionId, session);
  try {
    session.ws = await MiniWebSocket.connect(url, {
      onMessage: (text) => {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (!message || typeof message !== "object")
          return;
        pushEvent(session, message);
      },
      onClose: (reason) => {
        session.closed = true;
        session.reason = reason;
        wake(session);
      }
    }, { headers, timeoutMs });
  } catch (error) {
    sessions.delete(sessionId);
    return {
      status: 502,
      payload: { error: error instanceof Error ? error.message : String(error), code: "CDP_CONNECT" }
    };
  }
  return { status: 200, payload: { sessionId } };
}
async function route(req, res) {
  const authorization = String(req.headers?.authorization ?? "");
  if (authorization !== `Bearer ${TOKEN}`) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = String(req.method ?? "GET").toUpperCase();
  if (url.pathname === "/health") {
    json(res, 200, { status: "ok" });
    return;
  }
  if (url.pathname === "/shardx/discover") {
    if (method !== "POST" && method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleDiscover();
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/instances/running") {
    if (method !== "POST" && method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleInstancesRunning();
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/launcher/settings") {
    if (method !== "POST" && method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const body = method === "POST" ? await readJson(req) : {};
    const result = await handleLauncherSettings(body);
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/proxy") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleProxy(await readJson(req));
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/cdp/open") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleOpen(await readJson(req));
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/cdp/send") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const body = await readJson(req);
    const session = findSession(body.session);
    if (!session) {
      json(res, 404, { error: "CDP 会话不存在或已关闭", code: "NO_SESSION" });
      return;
    }
    if (session.closed || !session.ws) {
      json(res, 409, { error: session.reason || "CDP 连接已关闭", code: "CDP_CLOSED" });
      return;
    }
    const message = body.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      json(res, 400, { error: "message 必须是 CDP 消息对象", code: "BAD_MESSAGE" });
      return;
    }
    try {
      session.ws.send(JSON.stringify(message));
    } catch (error) {
      json(res, 502, {
        error: error instanceof Error ? error.message : String(error),
        code: "CDP_SEND"
      });
      return;
    }
    session.lastPoll = Date.now();
    json(res, 200, { sent: true });
    return;
  }
  if (url.pathname === "/cdp/events") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const body = await readJson(req);
    const session = findSession(body.session);
    if (!session) {
      json(res, 404, { error: "CDP 会话不存在或已关闭", code: "NO_SESSION" });
      return;
    }
    const waitMs = clampNumber(body.waitMs, 0, 5000, 0);
    const deadline = Date.now() + waitMs;
    session.lastPoll = Date.now();
    while (session.events.length === 0 && !session.closed && Date.now() < deadline) {
      await new Promise((resolve) => {
        const waker = () => {
          clearTimeout(timer);
          session.waiters.delete(waker);
          resolve();
        };
        const timer = setTimeout(() => {
          session.waiters.delete(waker);
          resolve();
        }, Math.max(20, deadline - Date.now()));
        session.waiters.add(waker);
      });
      session.lastPoll = Date.now();
    }
    const events = session.events.splice(0, session.events.length);
    session.eventBytes = 0;
    const gap = session.gap;
    session.gap = false;
    const closed = session.closed;
    const reason = session.reason;
    if (closed && events.length === 0)
      sessions.delete(session.id);
    json(res, 200, { events, closed, reason, gap });
    return;
  }
  if (url.pathname === "/cdp/close") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const body = await readJson(req);
    const session = findSession(body.session);
    if (session) {
      try {
        session.ws?.close("客户端关闭");
      } catch {}
      session.closed = true;
      session.reason = "客户端关闭";
      wake(session);
      sessions.delete(session.id);
    }
    json(res, 200, { closed: true });
    return;
  }
  if (url.pathname === "/workspace/state") {
    if (method !== "POST" && method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleWorkspaceStateRoute();
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/workspace/mapping") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleMapping(await readJson(req));
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/workspace/skill") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleSkillSave(await readJson(req));
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/workspace/skill/remove") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleSkillRemove(await readJson(req));
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/workspace/assign") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleAssign(await readJson(req));
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/workspace/settings") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleWorkspaceSettings(await readJson(req));
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/launcher/status") {
    if (method !== "POST" && method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleLauncherStatus();
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/workspace/server/status") {
    if (method !== "POST" && method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleServerStatus();
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/workspace/server/control") {
    if (method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleServerControl(await readJson(req));
    json(res, result.status, result.payload);
    return;
  }
  if (url.pathname === "/workspace/server/sync") {
    if (method !== "POST" && method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const result = await handleServerSync();
    json(res, result.status, result.payload);
    return;
  }
  json(res, 404, { error: "not found" });
}
var server = createServer((req, res) => {
  route(req, res).catch((error) => {
    if (error instanceof BodyTooLargeError) {
      json(res, 413, { error: "请求体过大", code: "BODY_TOO_LARGE" });
      return;
    }
    json(res, 500, {
      error: "桥接服务内部错误",
      code: "INTERNAL",
      detail: error instanceof Error ? error.message : String(error)
    });
  });
});
var sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of [...sessions.entries()]) {
    const idle = now - session.lastPoll > SESSION_IDLE_MS;
    const closedFor = session.closed && now - session.lastPoll > 30000;
    if (!idle && !closedFor)
      continue;
    try {
      session.ws?.close("空闲超时");
    } catch {}
    sessions.delete(id);
  }
}, 30000);
sweeper.unref?.();
function shutdown() {
  for (const session of sessions.values()) {
    try {
      session.ws?.close("服务停止");
    } catch {}
  }
  sessions.clear();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref?.();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`shardx-bridge listening on 127.0.0.1:${PORT}
`);
});
