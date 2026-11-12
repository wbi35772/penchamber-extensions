// service/main.ts
import { spawn as spawn6 } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsp10 from "node:fs/promises";
import http from "node:http";
import os7 from "node:os";
import path9 from "node:path";

// service/configStore.ts
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// shared/types.ts
var MATRIX_VERSION = "2.0.0";
var CONFIG_VERSION = 4;
var CONFIG_FILE_NAME = "openwith-matrix.json";
var DEFAULT_EXTENSION_CATEGORIES = [
  { id: "workspace", name: "工作台与界面" },
  { id: "dev", name: "开发 / Git / 项目" },
  { id: "ai", name: "AI 模型与用量" },
  { id: "memory", name: "记忆与上下文" },
  { id: "monitor", name: "运行监控" },
  { id: "infra", name: "基础设施 / 云 / 容器" },
  { id: "theme", name: "主题与遗留" },
  { id: "other", name: "其他" }
];
var DEFAULT_EXTENSION_ASSIGNMENTS = {
  openwith: "workspace",
  "files-nav": "workspace",
  "session-focus": "workspace",
  "agent-progress-probe": "workspace",
  queue: "workspace",
  canvas: "workspace",
  excalidraw: "workspace",
  "obsidian-panel": "workspace",
  "server-browser": "workspace",
  "ios-simulator": "workspace",
  "openchamber-translation": "workspace",
  "git-manager": "dev",
  "github-task-board": "dev",
  "gitlab-pipelines": "dev",
  "kanban-board": "dev",
  "openspec-board": "dev",
  makefile: "dev",
  "skills-manager": "dev",
  "agents-manager": "dev",
  "prompt-override": "dev",
  "openchamber-providers": "ai",
  "openchamber-router": "ai",
  balance: "ai",
  "deepseek-usage": "ai",
  "commandcode-usage": "ai",
  "token-plan-usage": "ai",
  "claude-accounts": "ai",
  "mlx-scope": "ai",
  "live-tps": "ai",
  "tps-meter": "ai",
  "context-inspector": "ai",
  "dcp-rc-stats": "ai",
  "engram-memory": "memory",
  "openchamber-memory-graph-ui": "memory",
  "magic-context-sidebar": "memory",
  "resource-monitor": "monitor",
  "system-monitor": "monitor",
  wakatime: "monitor",
  docker: "infra",
  "argocd-observer": "infra",
  instacloud: "infra",
  "instabox-matrix": "infra",
  "shardx-workspace": "infra",
  "everforest-theme": "theme"
};
var DEFAULT_HOME_SECTIONS = [
  { id: "guests", kind: "guests", label: "扩展", view: "list", visible: true },
  { id: "marketplace", kind: "marketplace", label: "扩展市场", view: "cards", visible: true },
  { id: "win11-apps", kind: "win11-apps", label: "应用", view: "cards", visible: true },
  { id: "shardx", kind: "shardx", label: "ShardX", view: "list", visible: true },
  { id: "wsl-ports", kind: "wsl-ports", label: "WSL 端口", view: "list", visible: true },
  {
    id: "docker-containers",
    kind: "docker-containers",
    label: "容器",
    view: "list",
    visible: true
  },
  { id: "k8s-forwards", kind: "k8s-forwards", label: "端口转发", view: "list", visible: true },
  {
    id: "cloud-bookmarks",
    kind: "cloud-bookmarks",
    label: "书签",
    view: "cards",
    visible: true
  },
  { id: "cloud-webhooks", kind: "cloud-webhooks", label: "Webhook", view: "list", visible: true }
];

// service/configStore.ts
var CONFIG_DIR = path.join(os.homedir(), ".config", "openchamber");
var CONFIG_PATH = path.join(CONFIG_DIR, CONFIG_FILE_NAME);
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function deepMerge(base, patch) {
  if (patch === undefined)
    return base;
  if (Array.isArray(patch))
    return patch;
  if (isRecord(base) && isRecord(patch)) {
    const next = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = key in next ? deepMerge(next[key], value) : value;
    }
    return next;
  }
  return patch;
}
var DEFAULT_CONFIG_FILE = "default-matrix.json";
var defaultCandidates = () => [
  path.join(import.meta.dirname, "..", "config", DEFAULT_CONFIG_FILE),
  path.join(import.meta.dirname, "..", "..", "config", DEFAULT_CONFIG_FILE),
  path.join(process.cwd(), "config", DEFAULT_CONFIG_FILE),
  path.join(import.meta.dirname, "..", "config", CONFIG_FILE_NAME),
  path.join(import.meta.dirname, "..", "..", "config", CONFIG_FILE_NAME),
  path.join(process.cwd(), "config", CONFIG_FILE_NAME)
];
var readJsonFile = async (file) => {
  const text = await fsp.readFile(file, "utf8");
  return JSON.parse(text);
};
var loadDefaults = async () => {
  const errors = [];
  for (const candidate of defaultCandidates()) {
    try {
      const parsed = await readJsonFile(candidate);
      if (isRecord(parsed))
        return parsed;
      errors.push(`${candidate}: not an object`);
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`default config not found (${errors.join("; ")})`);
};
var HOME_SECTION_KINDS = [
  "guests",
  "marketplace",
  "win11-apps",
  "shardx",
  "wsl-ports",
  "docker-containers",
  "k8s-forwards",
  "cloud-bookmarks",
  "cloud-webhooks",
  "custom-group"
];
var HOME_VIEW_MODES = ["list", "cards", "compact"];
var defaultSectionFor = (kind) => DEFAULT_HOME_SECTIONS.find((section) => section.kind === kind);
var normalizeExtensionLibrary = (raw) => {
  const source = isRecord(raw) ? raw : {};
  const seen = new Set;
  const categories = [];
  for (const entry of Array.isArray(source.categories) ? source.categories : []) {
    if (!isRecord(entry))
      continue;
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 24) : "";
    if (!name)
      continue;
    const wanted = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `cat-${categories.length + 1}`;
    let id = wanted;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${wanted}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    categories.push({ id, name });
  }
  if (!categories.length) {
    for (const fallback of DEFAULT_EXTENSION_CATEGORIES) {
      categories.push({ ...fallback });
      seen.add(fallback.id);
    }
  }
  const assignments = {};
  for (const [guestId, categoryId] of Object.entries(DEFAULT_EXTENSION_ASSIGNMENTS)) {
    if (seen.has(categoryId))
      assignments[guestId] = categoryId;
  }
  const rawAssignments = isRecord(source.assignments) ? source.assignments : {};
  for (const [guestId, categoryId] of Object.entries(rawAssignments)) {
    if (typeof categoryId === "string" && seen.has(categoryId))
      assignments[guestId] = categoryId;
  }
  return { categories, assignments };
};
var uniqueSectionId = (wanted, seen) => {
  if (!seen.has(wanted)) {
    seen.add(wanted);
    return wanted;
  }
  let index = 2;
  while (seen.has(`${wanted}-${index}`))
    index += 1;
  const id = `${wanted}-${index}`;
  seen.add(id);
  return id;
};
var normalizeSections = (raw, groups) => {
  const seen = new Set;
  const sections = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isRecord(entry))
      continue;
    const kind = HOME_SECTION_KINDS.find((value) => value === entry.kind);
    if (!kind)
      continue;
    const fallback = defaultSectionFor(kind);
    const groupId = kind === "custom-group" && typeof entry.groupId === "string" && entry.groupId.trim() ? entry.groupId.trim() : undefined;
    if (kind === "custom-group" && !groupId)
      continue;
    const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : fallback?.label ?? kind;
    const view = HOME_VIEW_MODES.find((value) => value === entry.view) ?? fallback?.view ?? "list";
    sections.push({
      id: uniqueSectionId(typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : fallback?.id ?? `section-${kind}`, seen),
      kind,
      label,
      view,
      visible: entry.visible !== false,
      ...entry.removed === true ? { removed: true } : {},
      ...groupId ? { groupId } : {}
    });
  }
  for (const fallback of DEFAULT_HOME_SECTIONS) {
    if (sections.some((section) => section.kind === fallback.kind))
      continue;
    sections.push({
      ...fallback,
      id: uniqueSectionId(fallback.id, seen)
    });
  }
  const knownGroups = new Set(groups.map((group) => group.id));
  const kept = sections.filter((section) => section.kind !== "custom-group" || section.groupId && knownGroups.has(section.groupId));
  for (const group of groups) {
    const existing = kept.find((section) => section.kind === "custom-group" && section.groupId === group.id);
    if (existing) {
      existing.label = group.name || existing.label;
      continue;
    }
    kept.push({
      id: uniqueSectionId(`group:${group.id}`, seen),
      kind: "custom-group",
      label: group.name || "自定义分组",
      view: "cards",
      visible: true,
      groupId: group.id
    });
  }
  return kept;
};
var normalize = (config) => {
  const next = config;
  next.version = CONFIG_VERSION;
  next.settings ??= {};
  next.groups ??= {};
  next.home ??= { pageSize: 8, groups: [], sections: [] };
  next.extensionLibrary = normalizeExtensionLibrary(next.extensionLibrary);
  if (!Array.isArray(next.home.groups))
    next.home.groups = [];
  next.home.groups = next.home.groups.filter(isRecord).map((group, groupIndex) => ({
    id: typeof group.id === "string" && group.id.trim() ? group.id.trim() : `group-${groupIndex + 1}`,
    name: typeof group.name === "string" && group.name.trim() ? group.name.trim() : "未命名分组",
    items: Array.isArray(group.items) ? group.items.filter(isRecord).map((item, itemIndex) => ({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `item-${groupIndex + 1}-${itemIndex + 1}`,
      kind: item.kind === "guest" || item.kind === "app" || item.kind === "bookmark" ? item.kind : "url",
      ref: typeof item.ref === "string" ? item.ref : "",
      ...typeof item.label === "string" && item.label.trim() ? { label: item.label.trim() } : {},
      ...typeof item.icon === "string" && item.icon.trim() ? { icon: item.icon.trim() } : {}
    })) : []
  }));
  next.home.sections = normalizeSections(next.home.sections, next.home.groups);
  if (typeof next.home.pageSize !== "number" || !Number.isFinite(next.home.pageSize) || next.home.pageSize < 3) {
    next.home.pageSize = 8;
  }
  const groups = next.groups;
  groups.guests ??= { enabled: true, order: [], hidden: [] };
  groups.win11 ??= { apps: [], shardx: [] };
  groups.wsl ??= { distros: [], ports: [] };
  groups.docker ??= { enabled: true, composeFiles: [], containers: [] };
  groups.k8s ??= { enabled: true, contexts: [], portForwards: [] };
  groups.cloud ??= { bookmarks: [], webhooks: [] };
  for (const key of ["apps", "shardx"]) {
    if (!Array.isArray(groups.win11[key]))
      groups.win11[key] = [];
  }
  if (!Array.isArray(groups.guests.order))
    groups.guests.order = [];
  if (!Array.isArray(groups.guests.hidden))
    groups.guests.hidden = [];
  if (!Array.isArray(groups.wsl.distros))
    groups.wsl.distros = [];
  if (!Array.isArray(groups.wsl.ports))
    groups.wsl.ports = [];
  if (!Array.isArray(groups.docker.composeFiles))
    groups.docker.composeFiles = [];
  if (!Array.isArray(groups.docker.containers))
    groups.docker.containers = [];
  if (!Array.isArray(groups.k8s.contexts))
    groups.k8s.contexts = [];
  if (!Array.isArray(groups.k8s.portForwards))
    groups.k8s.portForwards = [];
  if (!Array.isArray(groups.cloud.bookmarks))
    groups.cloud.bookmarks = [];
  if (!Array.isArray(groups.cloud.webhooks))
    groups.cloud.webhooks = [];
  if (!Array.isArray(next.settings.logSources))
    next.settings.logSources = [];
  return next;
};

class ConfigStore {
  current = null;
  defaults = null;
  listeners = new Set;
  async init() {
    this.defaults = await loadDefaults();
    let user = undefined;
    try {
      user = await readJsonFile(CONFIG_PATH);
    } catch {
      user = undefined;
    }
    const merged = deepMerge(structuredClone(this.defaults), user);
    this.current = normalize(merged);
    if (user === undefined) {
      await this.persist(this.current);
    }
    return this.current;
  }
  get() {
    if (!this.current)
      throw new Error("config store not initialised");
    return this.current;
  }
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async save(patch) {
    const base = this.get();
    const merged = normalize(deepMerge(structuredClone(base), patch));
    this.current = merged;
    await this.persist(merged);
    for (const listener of this.listeners) {
      try {
        listener(merged);
      } catch {}
    }
    return merged;
  }
  async reset() {
    if (!this.defaults)
      throw new Error("config store not initialised");
    const next = normalize(structuredClone(this.defaults));
    this.current = next;
    await this.persist(next);
    return next;
  }
  async persist(config) {
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
    const text = `${JSON.stringify(config, null, 2)}
`;
    await fsp.writeFile(tmp, text, "utf8");
    await fsp.rename(tmp, CONFIG_PATH);
  }
}

// service/processUtils.ts
import { spawn } from "node:child_process";
import fsp2 from "node:fs/promises";
import os2 from "node:os";
import path2 from "node:path";
var DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 255 && buffer[1] === 254) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 254 && buffer[1] === 255) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}
function expandHome(target) {
  if (target === "~")
    return os2.homedir();
  if (target.startsWith("~/") || target.startsWith("~\\")) {
    return path2.join(os2.homedir(), target.slice(2));
  }
  return target;
}
function quoteWindowsArg(value) {
  if (!/[\s"&|<>^]/.test(value))
    return value;
  return `"${value.replace(/"/g, '""')}"`;
}
function runCapture(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let child;
    let timer = null;
    const finish = (code, error) => {
      if (settled)
        return;
      settled = true;
      if (timer)
        clearTimeout(timer);
      resolve({
        code,
        stdout: decodeText(Buffer.concat(stdout)),
        stderr: decodeText(Buffer.concat(stderr)),
        timedOut,
        durationMs: Date.now() - startedAt,
        ...error ? { error } : {}
      });
    };
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: options.windowsHide ?? true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        finish(null, "timeout");
      }, options.timeoutMs);
    }
    child.stdout?.on("data", (chunk) => {
      if (stdoutBytes >= maxBytes)
        return;
      stdoutBytes += chunk.length;
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderrBytes >= maxBytes)
        return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}
function runDetached(command, args = [], options = {}) {
  try {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      windowsHide: false,
      stdio: "ignore"
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}
async function killTree(child) {
  const pid = child?.pid;
  if (!pid)
    return;
  if (process.platform === "win32") {
    await runCapture("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 5000 });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}
async function which(command) {
  if (!command)
    return false;
  if (path2.isAbsolute(command) || /^[A-Za-z]:[\\/]/.test(command)) {
    try {
      await fsp2.access(command);
      return true;
    } catch {
      return false;
    }
  }
  const result = process.platform === "win32" ? await runCapture("where.exe", [command], { timeoutMs: 5000 }) : await runCapture("sh", ["-lc", `command -v ${JSON.stringify(command)}`], {
    timeoutMs: 5000
  });
  return result.code === 0 && result.stdout.trim().length > 0;
}
function toWindowsPath(target) {
  if (/^[A-Za-z]:[\\/]/.test(target))
    return target.replace(/\//g, "\\");
  if (target.startsWith("/mnt/") && target.length > 6) {
    const drive = target[5]?.toUpperCase() ?? "C";
    return `${drive}:${target.slice(6).replace(/\//g, "\\")}`;
  }
  return target.replace(/\//g, "\\");
}

// service/dockerController.ts
var VERSION_TIMEOUT_MS = 6000;
var LIST_TIMEOUT_MS = 1e4;
var ACTION_TIMEOUT_MS = 60000;
var PS_FORMAT = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}";
var parseContainers = (stdout) => stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => {
  const [id = "", name = "", image = "", state = "", status = "", ports = "", createdAt = ""] = line.split("\t");
  return { id, name, image, state, status, ports, ...createdAt ? { createdAt } : {} };
}).filter((container) => container.id.length > 0);

class DockerController {
  async snapshot() {
    const version = await runCapture("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: VERSION_TIMEOUT_MS,
      maxBytes: 8192
    });
    if (version.code !== 0) {
      return {
        available: false,
        containers: [],
        error: (version.stderr || version.stdout || version.error || "docker-unavailable").trim()
      };
    }
    const list = await runCapture("docker", ["ps", "-a", "--no-trunc", "--format", PS_FORMAT], {
      timeoutMs: LIST_TIMEOUT_MS,
      maxBytes: 2 * 1024 * 1024
    });
    if (list.code !== 0) {
      return {
        available: true,
        version: version.stdout.trim(),
        containers: [],
        error: (list.stderr || list.error || "docker-ps-failed").trim()
      };
    }
    return {
      available: true,
      version: version.stdout.trim(),
      containers: parseContainers(list.stdout)
    };
  }
  async containerAction(id, action) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
      return { ok: false, detail: "invalid-container-id" };
    }
    const result = await runCapture("docker", [action, id], {
      timeoutMs: ACTION_TIMEOUT_MS,
      maxBytes: 64 * 1024
    });
    return {
      ok: result.code === 0,
      detail: (result.code === 0 ? result.stdout : result.stderr || result.error || "").trim()
    };
  }
  async compose(action, files, cwd) {
    const args = ["compose"];
    for (const file of files)
      args.push("-f", file);
    if (action === "up")
      args.push("up", "-d", "--remove-orphans");
    else if (action === "restart")
      args.push("restart");
    else if (action === "ps")
      args.push("ps");
    else
      args.push("down", "--remove-orphans");
    const result = await runCapture("docker", args, {
      timeoutMs: ACTION_TIMEOUT_MS,
      cwd,
      maxBytes: 256 * 1024
    });
    return {
      ok: result.code === 0,
      detail: (result.code === 0 ? result.stdout : result.stderr || result.error || "").trim()
    };
  }
}

// service/guestManager.ts
import fsp3 from "node:fs/promises";
import os3 from "node:os";
import path3 from "node:path";
var SETTINGS_PATH = path3.join(os3.homedir(), ".config", "openchamber", "settings.json");
var FALLBACK_BASE = "http://127.0.0.1:53253";
var REQUEST_TIMEOUT_MS = 15000;
var ICON_MIME = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon"
};
var MAX_ICON_BYTES = 128 * 1024;
var META_TTL_MS = 60000;
var UPDATE_TTL_MS = 5 * 60000;
var UPDATE_FAILURE_TTL_MS = 30000;
var toSummary = (record) => ({
  id: String(record.id ?? ""),
  name: String(record.name ?? record.id ?? ""),
  ...record.icon ? { icon: record.icon } : {},
  enabled: record.enabled !== false,
  ...record.version ? { version: record.version } : {},
  ...record.source ? { source: record.source } : {},
  ...record.path ? { path: record.path } : {},
  ...record.entry ? { entry: record.entry } : {},
  ...record.pageEntry ? { pageEntry: record.pageEntry } : {},
  ...record.fileEditors?.length ? { fileEditors: record.fileEditors } : {},
  ...record.storageId ? { storageId: record.storageId } : {},
  ...record.capabilities ? {
    capabilities: {
      ...record.capabilities.requested ? { requested: record.capabilities.requested } : {},
      ...record.capabilities.granted ? { granted: record.capabilities.granted } : {}
    }
  } : {},
  ...record.service ? {
    service: {
      ...record.service.runtime ? { runtime: record.service.runtime } : {},
      ...record.service.granted !== undefined ? { granted: record.service.granted } : {},
      ...record.service.permissions ? { permissions: record.service.permissions } : {}
    }
  } : {}
});

class GuestManager {
  log;
  cachedBase = null;
  metaCache = new Map;
  updateCache = null;
  constructor(log) {
    this.log = log;
  }
  async baseUrl() {
    if (this.cachedBase)
      return this.cachedBase;
    const agentUrl = process.env.OPENCHAMBER_AGENT_TOOL_URL;
    if (agentUrl) {
      try {
        this.cachedBase = new URL(agentUrl).origin;
        return this.cachedBase;
      } catch {}
    }
    try {
      const text = await fsp3.readFile(SETTINGS_PATH, "utf8");
      const settings = JSON.parse(text);
      if (typeof settings.desktopLocalPort === "number" && settings.desktopLocalPort > 0) {
        this.cachedBase = `http://127.0.0.1:${settings.desktopLocalPort}`;
        return this.cachedBase;
      }
    } catch {}
    this.cachedBase = FALLBACK_BASE;
    return this.cachedBase;
  }
  async request(method, route, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    const base = await this.baseUrl();
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      const message = `host ${method} ${route} -> ${response.status}: ${text.slice(0, 300)}`;
      this.log(`guest bridge: ${message}`);
      throw new Error(message);
    }
    return text ? JSON.parse(text) : {};
  }
  async list() {
    const answer = await this.request("GET", "/api/guests");
    const records = Array.isArray(answer.guests) ? answer.guests : [];
    const updates = this.updateCache?.checked ? this.updateCache : { at: 0, checked: false, versions: new Map };
    const metas = await Promise.all(records.map((record) => this.localMeta(record)));
    return records.map((record, index) => {
      const summary = toSummary(record);
      const meta = metas[index] ?? {};
      const originUrl = record.origin?.url?.trim();
      const latestVersion = updates.versions.get(summary.id) ?? record.update?.version?.trim();
      return {
        ...summary,
        ...originUrl ? { originUrl } : {},
        ...meta.repoUrl ? { repoUrl: meta.repoUrl } : {},
        ...meta.iconData ? { iconData: meta.iconData } : {},
        ...latestVersion ? { latestVersion } : {},
        ...originUrl ? { updateChecked: updates.checked || Boolean(record.update?.version) } : {}
      };
    }).filter((guest) => guest.id.length > 0);
  }
  async localMeta(record) {
    const dir = record.path?.trim();
    if (!dir)
      return {};
    const cached = this.metaCache.get(dir);
    if (cached && Date.now() - cached.at < META_TTL_MS)
      return cached.value;
    const value = {};
    let iconName = record.icon?.trim();
    try {
      const text = await fsp3.readFile(path3.join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(text);
      const repository = pkg.repository;
      const repoUrl = typeof repository === "string" ? repository : repository?.url;
      if (repoUrl?.trim())
        value.repoUrl = repoUrl.trim();
      iconName = iconName || pkg.openchamber?.contributes?.panel?.icon?.trim();
    } catch {}
    if (iconName && /[./\\]/.test(iconName)) {
      const baseDir = path3.resolve(dir);
      const file = path3.resolve(baseDir, iconName);
      const relative = path3.relative(baseDir, file);
      const extension = path3.extname(file).toLowerCase();
      const mime = ICON_MIME[extension];
      if (mime && relative && !relative.startsWith("..") && !path3.isAbsolute(relative)) {
        try {
          const buffer = await fsp3.readFile(file);
          if (buffer.byteLength > 0 && buffer.byteLength <= MAX_ICON_BYTES) {
            value.iconData = `data:${mime};base64,${buffer.toString("base64")}`;
          }
        } catch {}
      }
    }
    this.metaCache.set(dir, { at: Date.now(), value });
    return value;
  }
  async updates(force) {
    const ttl = this.updateCache?.checked ? UPDATE_TTL_MS : UPDATE_FAILURE_TTL_MS;
    if (!force && this.updateCache && Date.now() - this.updateCache.at < ttl) {
      return this.updateCache;
    }
    try {
      const answer = await this.request("POST", "/api/guests/updates/check", { force }, 60000);
      const versions = new Map;
      for (const [id, entry] of Object.entries(answer.updates ?? {})) {
        const version = entry?.version?.trim();
        if (version)
          versions.set(id, version);
      }
      this.updateCache = { at: Date.now(), checked: true, versions };
    } catch (error) {
      this.log(`guest update check failed: ${error instanceof Error ? error.message : String(error)}`);
      this.updateCache = { at: Date.now(), checked: false, versions: new Map };
    }
    return this.updateCache;
  }
  async checkUpdates(force = true) {
    const state = await this.updates(force);
    return Object.fromEntries(state.versions);
  }
  async update(id) {
    const result = await this.request("POST", `/api/guests/${encodeURIComponent(id)}/update`, undefined, 180000);
    this.updateCache = null;
    this.metaCache.clear();
    return result;
  }
  async install(url) {
    const result = await this.request("POST", "/api/guests", { url }, 180000);
    this.updateCache = null;
    this.metaCache.clear();
    return result;
  }
  async uninstall(id) {
    await this.request("DELETE", `/api/guests/${encodeURIComponent(id)}`, undefined, 60000);
    this.updateCache = null;
    this.metaCache.clear();
  }
  async frameGrant(id, entry = "panel/index.html") {
    const grant = await this.request("POST", `/api/guests/${encodeURIComponent(id)}/frame-grant`, {});
    if (!grant.grant)
      throw new Error("host returned no frame grant");
    const base = await this.baseUrl();
    return {
      grant: grant.grant,
      expiresAt: Number(grant.expiresAt ?? Date.now() + 60000),
      url: `${base}/api/guest-files/${grant.grant}/${entry.replace(/^\/+/, "")}`
    };
  }
  async setEnabled(id, enabled) {
    await this.request("PUT", `/api/guests/${encodeURIComponent(id)}/enabled`, { enabled });
  }
  async serviceRequest(id, request) {
    const body = typeof request.body === "string" ? request.body : request.body === undefined ? undefined : JSON.stringify(request.body);
    const answer = await this.request("POST", `/api/guests/${encodeURIComponent(id)}/service/request`, {
      method: request.method,
      path: request.path,
      ...request.query ? { query: request.query } : {},
      ...body !== undefined ? { body } : {}
    });
    return {
      status: Number(answer.status ?? 0),
      body: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? "")
    };
  }
  async serviceStatus(id) {
    const answer = await this.request("GET", `/api/guests/${encodeURIComponent(id)}/service/status`);
    const status = typeof answer.status === "string" ? answer.status : "stopped";
    const known = status === "stopped" || status === "starting" || status === "ready" || status === "failed";
    return { status: known ? status : "stopped" };
  }
  async storage(id, body) {
    return this.request("POST", `/api/guests/${encodeURIComponent(id)}/storage`, body);
  }
}

// service/hostLauncher.ts
import fsp4 from "node:fs/promises";
import path4 from "node:path";
var CACHE_TTL_MS = 30000;
var isWindowsShim = (command) => /\.(cmd|bat)$/i.test(command);
var launch = (command, args, cwd) => {
  const pid = isWindowsShim(command) ? runDetached("cmd.exe", ["/d", "/s", "/c", [command, ...args].map(quoteWindowsArg).join(" ")], {
    cwd
  }) : runDetached(command, args, { cwd });
  return pid ? { ok: true } : { ok: false, error: "spawn-failed" };
};

class HostLauncher {
  cache = new Map;
  apps = [];
  setApps(apps) {
    this.apps = apps;
  }
  async detect(refresh = false) {
    const now = Date.now();
    const answers = [];
    for (const app of this.apps) {
      let cached = this.cache.get(app.id);
      if (!cached || refresh || now - cached.at > CACHE_TTL_MS) {
        cached = { installed: await which(app.command), at: now };
        this.cache.set(app.id, cached);
      }
      answers.push({
        id: app.id,
        name: app.name,
        command: app.command,
        installed: cached.installed,
        ...app.icon ? { icon: app.icon } : {}
      });
    }
    return answers;
  }
  async open(id, directory) {
    const app = this.apps.find((candidate) => candidate.id === id);
    if (!app)
      return { ok: false, error: "unknown-app" };
    if (process.env.OPENCHAMBER_OPENWITH_DRY_RUN === "1")
      return { ok: true };
    try {
      const stat = await fsp4.stat(directory);
      if (!stat.isDirectory())
        return { ok: false, error: "not-a-directory" };
    } catch {
      return { ok: false, error: "directory-missing" };
    }
    const apps = await this.detect();
    if (!apps.find((candidate) => candidate.id === id)?.installed) {
      return { ok: false, error: "not-installed" };
    }
    const hasPositional = app.args.some((arg) => !arg.startsWith("-"));
    const args = hasPositional ? [...app.args] : [...app.args, directory];
    return launch(app.command, args, path4.dirname(directory));
  }
  async launchCommand(command, args = [], cwd) {
    if (process.env.OPENCHAMBER_OPENWITH_DRY_RUN === "1")
      return { ok: true };
    return launch(command, args, cwd);
  }
  invalidate() {
    this.cache.clear();
  }
}

// service/k8sController.ts
import { spawn as spawn2 } from "node:child_process";
var QUERY_TIMEOUT_MS = 12000;
var ageFrom = (timestamp) => {
  if (!timestamp)
    return "-";
  const started = Date.parse(timestamp);
  if (Number.isNaN(started))
    return "-";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60)
    return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};
var toPod = (pod, context) => {
  const containers = pod.status?.containerStatuses ?? [];
  const ready = containers.filter((container) => container.ready === true).length;
  const restarts = containers.reduce((total, container) => total + (container.restartCount ?? 0), 0);
  return {
    name: pod.metadata?.name ?? "",
    namespace: pod.metadata?.namespace ?? "",
    context,
    status: pod.status?.phase ?? "Unknown",
    ready: `${ready}/${containers.length}`,
    restarts: String(restarts),
    age: ageFrom(pod.metadata?.creationTimestamp)
  };
};

class K8sController {
  forwards = new Map;
  async snapshot(settings) {
    const version = await runCapture("kubectl", ["version", "--client", "-o", "json"], {
      timeoutMs: 6000,
      maxBytes: 64 * 1024
    });
    if (version.code !== 0) {
      return {
        available: false,
        contexts: [],
        pods: [],
        forwards: this.forwardList(),
        error: (version.stderr || version.error || "kubectl-unavailable").trim()
      };
    }
    const config = await runCapture("kubectl", ["config", "view", "-o", "json"], {
      timeoutMs: 8000,
      maxBytes: 2 * 1024 * 1024
    });
    let currentContext = settings.defaultContext;
    let contexts = [];
    if (config.code === 0) {
      try {
        const parsed = JSON.parse(config.stdout);
        currentContext = parsed["current-context"] || currentContext;
        contexts = (parsed.contexts ?? []).map((entry) => ({
          name: entry.name ?? "",
          cluster: entry.context?.cluster ?? "",
          user: entry.context?.user ?? "",
          namespace: entry.context?.namespace ?? settings.defaultNamespace,
          current: (entry.name ?? "") === currentContext
        }));
      } catch {}
    }
    const pods = [];
    let error;
    const activeContext = currentContext || contexts[0]?.name || "";
    const podArgs = ["get", "pods", "-A"];
    if (activeContext)
      podArgs.push("--context", activeContext);
    podArgs.push("-o", "json");
    const podResult = await runCapture("kubectl", podArgs, {
      timeoutMs: QUERY_TIMEOUT_MS,
      maxBytes: 6 * 1024 * 1024
    });
    if (podResult.code === 0) {
      try {
        const parsed = JSON.parse(podResult.stdout);
        for (const item of parsed.items ?? [])
          pods.push(toPod(item, activeContext));
      } catch {
        error = "kubectl returned malformed JSON";
      }
    } else {
      error = (podResult.stderr || podResult.error || "kubectl-get-pods-failed").trim();
    }
    return {
      available: true,
      contexts,
      pods,
      forwards: this.forwardList(),
      ...error ? { error } : {}
    };
  }
  async startForward(config) {
    const id = `${config.context}:${config.namespace}:${config.pod}:${config.localPort}`;
    const existing = this.forwards.get(id);
    if (existing && existing.child.exitCode === null)
      return existing.info;
    for (const entry of this.forwards.values()) {
      if (entry.info.localPort === config.localPort && entry.child.exitCode === null) {
        return {
          id,
          ...config,
          running: false,
          error: `local port ${config.localPort} is already forwarded`
        };
      }
    }
    const child = spawn2("kubectl", [
      "--context",
      config.context,
      "--namespace",
      config.namespace,
      "port-forward",
      `pod/${config.pod}`,
      `${config.localPort}:${config.remotePort}`
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const info = {
      id,
      ...config,
      running: true,
      ...child.pid ? { pid: child.pid } : {}
    };
    const entry = { child, info, stderr: "" };
    this.forwards.set(id, entry);
    child.stderr?.on("data", (chunk) => {
      entry.stderr = `${entry.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("exit", () => {
      info.running = false;
      if (entry.stderr.trim())
        info.error = entry.stderr.trim().slice(-600);
    });
    child.on("error", (error) => {
      info.running = false;
      info.error = error.message;
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (child.exitCode !== null) {
      info.running = false;
      info.error = entry.stderr.trim() || `kubectl exited with ${child.exitCode}`;
    }
    return info;
  }
  async stopForward(id) {
    const entry = this.forwards.get(id);
    if (!entry)
      return false;
    await killTree(entry.child);
    entry.info.running = false;
    this.forwards.delete(id);
    return true;
  }
  async stopAll() {
    const children = [...this.forwards.values()].map((entry) => entry.child);
    this.forwards.clear();
    await Promise.all(children.map((child) => killTree(child)));
  }
  forwardList() {
    return [...this.forwards.values()].map((entry) => ({ ...entry.info }));
  }
}

// service/logController.ts
import { spawn as spawn3 } from "node:child_process";
import fsp5 from "node:fs/promises";
var MAX_SUBSCRIPTIONS = 24;
var MAX_CHUNKS = 500;
var MAX_BYTES = 512 * 1024;
var FILE_POLL_MS = 500;
var URL_POLL_MS = 2000;
var counter = 0;
var nextId = () => `log-${Date.now().toString(36)}-${counter += 1}`;

class LogController {
  getConfig;
  subscriptions = new Map;
  constructor(getConfig) {
    this.getConfig = getConfig;
  }
  sources() {
    const sources = this.getConfig().settings.logSources;
    return Promise.all(sources.map(async (source) => {
      let available = true;
      let error;
      if (source.kind === "file") {
        try {
          await fsp5.access(expandHome(source.target));
        } catch {
          available = false;
          error = "file-missing";
        }
      } else if (source.kind === "command") {
        available = await which(source.target);
        if (!available)
          error = "command-missing";
      }
      return {
        id: source.id,
        name: source.name,
        kind: source.kind,
        target: source.target,
        available,
        ...error ? { error } : {}
      };
    }));
  }
  subscribe(sourceId) {
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw new Error("too-many-log-subscriptions");
    }
    const source = this.getConfig().settings.logSources.find((entry) => entry.id === sourceId);
    if (!source)
      throw new Error("unknown-log-source");
    const subscription = {
      id: nextId(),
      source,
      createdAt: Date.now(),
      alive: true,
      chunks: [],
      bytes: 0,
      seq: 1,
      truncated: false
    };
    this.subscriptions.set(subscription.id, subscription);
    if (source.kind === "file")
      this.startFile(subscription);
    else if (source.kind === "command")
      this.startCommand(subscription);
    else
      this.startUrl(subscription);
    return this.info(subscription);
  }
  list() {
    return [...this.subscriptions.values()].map((subscription) => this.info(subscription));
  }
  output(id, since = 0) {
    const subscription = this.subscriptions.get(id);
    if (!subscription)
      return null;
    const chunks = subscription.chunks.filter((chunk) => chunk.seq > since);
    return {
      chunks,
      nextSeq: subscription.seq,
      truncated: subscription.truncated || chunks.length > 0 && chunks[0].seq > since + 1,
      alive: subscription.alive,
      ...subscription.error ? { error: subscription.error } : {}
    };
  }
  async stop(id) {
    const subscription = this.subscriptions.get(id);
    if (!subscription)
      return false;
    subscription.alive = false;
    if (subscription.timer)
      clearInterval(subscription.timer);
    if (subscription.child)
      await killTree(subscription.child);
    this.subscriptions.delete(id);
    return true;
  }
  async stopAll() {
    const children = [...this.subscriptions.values()].map((subscription) => subscription.child).filter((child) => Boolean(child));
    for (const subscription of this.subscriptions.values()) {
      if (subscription.timer)
        clearInterval(subscription.timer);
    }
    this.subscriptions.clear();
    await Promise.all(children.map((child) => killTree(child)));
  }
  push(subscription, stream, text) {
    if (!text)
      return;
    subscription.chunks.push({
      seq: subscription.seq,
      sourceId: subscription.source.id,
      stream,
      text,
      at: Date.now()
    });
    subscription.seq += 1;
    subscription.bytes += Buffer.byteLength(text, "utf8");
    while (subscription.chunks.length > MAX_CHUNKS || subscription.bytes > MAX_BYTES) {
      const dropped = subscription.chunks.shift();
      if (!dropped)
        break;
      subscription.bytes -= Buffer.byteLength(dropped.text, "utf8");
      subscription.truncated = true;
    }
  }
  startFile(subscription) {
    const file = expandHome(subscription.source.target);
    const tick = async () => {
      if (subscription.busy || !subscription.alive)
        return;
      subscription.busy = true;
      try {
        const handle = await fsp5.open(file, "r");
        try {
          const stat = await handle.stat();
          if (subscription.offset === undefined) {
            subscription.offset = Math.max(0, stat.size - 64 * 1024);
          } else if (stat.size < subscription.offset) {
            subscription.offset = 0;
            this.push(subscription, "system", `
[file truncated]
`);
          }
          const remaining = stat.size - subscription.offset;
          if (remaining > 0) {
            const length = Math.min(remaining, 256 * 1024);
            const buffer = Buffer.alloc(length);
            const read = await handle.read(buffer, 0, length, subscription.offset);
            if (read.bytesRead > 0) {
              subscription.offset += read.bytesRead;
              this.push(subscription, "stdout", buffer.subarray(0, read.bytesRead).toString("utf8"));
            }
          }
        } finally {
          await handle.close();
        }
      } catch (error) {
        subscription.error = error instanceof Error ? error.message : String(error);
      } finally {
        subscription.busy = false;
      }
    };
    subscription.timer = setInterval(() => void tick(), FILE_POLL_MS);
    tick();
  }
  startCommand(subscription) {
    const source = subscription.source;
    let child;
    try {
      child = spawn3(source.target, source.args ?? [], {
        cwd: source.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      subscription.alive = false;
      subscription.error = error instanceof Error ? error.message : String(error);
      this.push(subscription, "system", `[spawn failed] ${subscription.error}
`);
      return;
    }
    subscription.child = child;
    child.stdout?.on("data", (chunk) => this.push(subscription, "stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => this.push(subscription, "stderr", chunk.toString("utf8")));
    child.on("error", (error) => {
      subscription.alive = false;
      subscription.error = error.message;
      this.push(subscription, "system", `[spawn error] ${error.message}
`);
    });
    child.on("exit", (code, signal) => {
      subscription.alive = false;
      this.push(subscription, "system", `
[process exited code=${code ?? "-"} signal=${signal ?? "-"}]
`);
    });
  }
  startUrl(subscription) {
    const tick = async () => {
      if (subscription.busy || !subscription.alive)
        return;
      subscription.busy = true;
      try {
        const response = await fetch(subscription.source.target, {
          signal: AbortSignal.timeout(8000)
        });
        const text = await response.text();
        if (text !== subscription.lastBody) {
          const previous = subscription.lastBody;
          subscription.lastBody = text;
          if (previous && text.startsWith(previous)) {
            this.push(subscription, "stdout", text.slice(previous.length));
          } else {
            this.push(subscription, "stdout", text.slice(0, 256 * 1024));
          }
        }
        subscription.error = undefined;
      } catch (error) {
        subscription.error = error instanceof Error ? error.message : String(error);
      } finally {
        subscription.busy = false;
      }
    };
    subscription.timer = setInterval(() => void tick(), URL_POLL_MS);
    tick();
  }
  info(subscription) {
    return {
      id: subscription.id,
      sourceId: subscription.source.id,
      name: subscription.source.name,
      kind: subscription.source.kind,
      target: subscription.source.target,
      alive: subscription.alive,
      createdAt: subscription.createdAt,
      ...subscription.error ? { error: subscription.error } : {}
    };
  }
}

// service/logger.ts
import fsp6 from "node:fs/promises";
import os4 from "node:os";
import path5 from "node:path";
var LOG_DIR = path5.join(os4.homedir(), ".config", "openchamber-openwith", "logs");
var LOG_FILE = path5.join(LOG_DIR, "service.log");
var MAX_BYTES2 = 10 * 1024 * 1024;
var MAX_BACKUPS = 3;
var size = -1;
var queue = Promise.resolve();
var rotate = async () => {
  for (let i = MAX_BACKUPS - 1;i >= 1; i -= 1) {
    await fsp6.rename(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`).catch(() => {
      return;
    });
  }
  await fsp6.rename(LOG_FILE, `${LOG_FILE}.1`).catch(() => {
    return;
  });
};
var append = async (line) => {
  try {
    if (size < 0) {
      await fsp6.mkdir(LOG_DIR, { recursive: true });
      size = (await fsp6.stat(LOG_FILE).catch(() => null))?.size ?? 0;
    }
    const bytes = Buffer.byteLength(line);
    if (size + bytes > MAX_BYTES2) {
      await rotate();
      size = 0;
    }
    await fsp6.appendFile(LOG_FILE, line);
    size += bytes;
  } catch {}
};
var log = (message) => {
  const line = `${new Date().toISOString()} ${message}
`;
  process.stderr.write(`[openwith] ${message}
`);
  queue = queue.then(() => append(line));
};

// service/marketplace.ts
import fsp7 from "node:fs/promises";
import path6 from "node:path";

// service/marketplaceZh.ts
var MARKETPLACE_ZH = {
  "official-openchamber-kanban": "任务看板：每张卡片都能启动独立的智能体会话，之后还能重新打开那段对话；卡片可拖动或用按钮在列之间移动。",
  "official-docker": "OpenChamber 内的 Docker 面板：容器、Compose 堆栈、镜像、卷、网络和磁盘占用。",
  "official-design-studio": "在聊天旁实时预览正在运行的应用（Chrome）。选中页面元素，智能体就会直接修改项目。",
  "kotobarsik-openchamber-ru-installer": "OpenChamber 与 OpenCode 的俄语翻译安装器（Windows）。",
  "official-server-browser": "在服务器上运行 Chrome，并把浏览器画面共享到 OpenChamber 里。",
  "pgquiles-opencode-muse": "OpenCode 的 Muse Code 订阅提供商插件。",
  "official-openspec": "浏览规划文档与任务进度，管理变更并准备工作流提示词；需要服务器上安装 CLI。",
  "official-live-tps": "在「工作状态」面板显示生成速度、上一轮平均值、首 Token 时间和迷你走势图。",
  "official-agent-progress": "按会话展示计划、任务状态以及每个智能体报告的已完成、进行中、受阻或跳过事项，并提供跨项目看板；会安装 OpenCode 配套插件，支持 Linux 和 Windows。",
  "official-deepseek-usage": "以人民币显示 DeepSeek 余额、用量以及高峰/低谷计费。",
  "official-system-monitor": "在侧栏面板和「工作状态」中显示运行 OpenChamber 那台机器的 CPU、内存、GPU 和磁盘占用。",
  "official-openchamber-queue": "按项目维护任务队列，项目空闲时用全新会话依次执行每个提示词；关闭页面后仍会继续派发。",
  "official-session-focus": "在「工作状态」中显示会话正在做什么、当前进行到哪一步以及约定步骤（完成后打勾）；需要配套的 OpenCode 插件。",
  "official-wakatime": "侧面板显示编码时长、每日活动、语言与项目排行，以及 AI 编码统计。",
  "eliottness-antechamber": "用最成熟的智能体桌面应用（OpenChamber）搭配一流的执行框架（OmO senpi）。",
  "official-mlx-scope": "本地 MLX 运行时的只读监控：吞吐、预填充、缓存和内存。",
  "josuegalre-openchamber-droplet": "把 OpenChamber 放进刘海屏：用 Droppy 水滴查看编码会话、审批和套餐用量。",
  "official-artifact-gallery": "集中查看会话中产生的页面、图片和文件；可预览原件，并把引用加入草稿。",
  "official-claude-account-switcher": "保存多个 Claude Code 登录账号，并在「工作状态」或侧面板中切换；仅支持 Windows 和 Linux。",
  "official-github-task-board": "把 GitHub Issue 显示为看板、列表或依赖图，并关联到正在处理它的智能体会话；可从任务启动智能体，并把清单同步回去。需要 GitHub Token。",
  "wichardriezebos-even-terminal-opencode": "在 Even Realities G2 眼镜上运行 OpenChamber 会话：even-terminal 桥接支持终端模式串流、戒指审批、ask 工具回答和语音。",
  "official-git-manager": "仿 IntelliJ IDEA 的 Git 窗口：分支、提交日志、差异、合并、变基、拣选、暂存和工作树；请按 README 中的发布分支 URL 安装。",
  "official-providers": "把自定义 OpenAI 兼容提供商和模型写入 opencode.json，并设置上下文长度与推理等级。",
  "official-tps-monitor": "在打开的会话中滚动显示最近五秒的每秒 Token 数。",
  "official-context-inspector": "查看当前会话的上下文窗口被什么占满：MCP 与内置工具、技能、AGENTS.md 规则、DCP 压缩以及对话本身；只读取本地数据。",
  "official-open-with": "用机器上已安装的编辑器、终端或文件管理器打开当前项目；请按 README 中的发布压缩包安装。",
  "official-engram": "搜索并阅读智能体保存到 Engram 的项目记忆；只读，需要 Engram 3.4 或更高版本。",
  "official-memory-graph-ui": "在 OpenChamber 内打开本地 opencode-mem 管理界面。",
  "official-command-code-usage": "Command Code 的配额窗口、点数、Token 与账单统计。",
  "official-prompt-override": "替换 OpenCode build 智能体的系统提示词，支持差异预览、自动备份和恢复内置提示词；不建议与 Claude Code 提供商插件同时使用。中文界面。",
  "official-git-graph": "以只读图表展示当前项目的提交历史、分支、合并和标签，智能体提交后自动更新；点击提交可查看差异。",
  "official-squeez-stats": "按会话、命令和工具显示 squeez 节省的 Token，以及错误和磁盘占用；数据来自本地文件，需要先安装 squeez。",
  "gadarianzhang-openchamber-trajectory": "OpenChamber 轨迹面板：由 OpenCode 采集插件驱动的分步时间线、工具调用、耗时和 Token。",
  "official-magic-context": "读取本地 Magic Context 实例的 Token 用量、记忆数量和只读缓存诊断。",
  "official-openchamber-makefile": "列出项目 Makefile 中的目标，并在侧面板运行，实时显示输出。",
  "official-gitlab-pipelines": "跟踪当前项目的 CI/CD 流水线，读取任务日志，并重试、取消或触发运行。",
  "official-everforest-theme": "Everforest 配色，共六种变体：深色或浅色，每种都有硬、中、软三档对比度。",
  "official-files": "文件面板：项目与主目录树、面包屑导航，以及多标签 CodeMirror 编辑器。",
  "ali3nz-singularity-repoql": "面向编码智能体的自托管记忆：持久记忆、专用智能体，以及 Claude Code 的 RepoQL。",
  "bashrusakh-opencode-agents": "我自己的 opencode/openchamber 智能体配置。",
  "jks15satoshi-opencode-container": "OpenCode 与 OpenChamber 的容器化部署方案。",
  "bd7pil-ocrc": "通过 SSH 部署和驱动远程 OpenChamber 实例：安装、出口中继、配对到桌面端，以及同步配置和凭据。",
  "amirghaghighi-openchamber-docker-builder": "OpenChamber Web 的 Docker 方案。",
  "icebluerabbit-openchamber-flake": "OpenChamber 的 Nix flake 和 NixOS 模块——包含 Web 守护进程和 Electron 桌面客户端。",
  "official-skills-manager": "逐个或按保存的分组开关全局 OpenCode 技能，并检查名称冲突。中文界面。",
  "official-agents-md-manager": "保存多份全局 AGENTS.md 并在它们之间切换，支持逐行差异、备份和恢复。中文界面。",
  "official-session-todos": "按单个或全部会话展示智能体待办清单，并保留未完成项的历史记录、你自己的备注，以及可选的小模型摘要；需要 oh-my-openagent 或 OpenCode 的实验性待办设置。",
  "official-mcp-manager": "在一个面板里管理全局 OpenCode 配置中的所有 MCP 服务器：开关、编辑或导入，并根据 OpenCode 日志排查连接失败原因。",
  "official-omo-slim-preset-selector": "显示当前生效的 oh-my-opencode-slim 预设及其智能体模型，标记已不存在的模型，并支持切换预设；切换后需重启服务生效。",
  "oroszgy-openchamber-litellm-usage": "在 OpenChamber「工作状态」中显示自托管 LiteLLM 代理的支出。",
  "batteryshark-agent-canvas": "为 OpenCode 智能体保存的可交互视觉界面：可在 OpenChamber、浏览器或手机上查看 OpenUI 与 HTML 视图。",
  "official-canvas": "智能体产出的图表、示意图、报告和原型图库，按版本保存，可重新打开、对比和评论；需要在 OpenCode 中注册其 MCP 服务器。",
  "lanlanff-ocwire": "通过盲中继端到端加密，在聊天里远程控制另一台电脑上的 opencode/OpenChamber，无需端口、VPN 或 SSH。",
  "gaojunran-openchamber-magic-context": "OpenChamber 的 Magic Context 面板——在右侧栏查看上下文用量、记忆和备注。",
  "official-dcp-rc-stats": "在侧栏和「工作状态」中显示当前会话及累计的 DCP RC 压缩统计；需要 DCP RC 插件。",
  "lantzleiweke-abacus": "Abacus：在右侧栏、智能体旁边显示 Beads Issue 的 OpenChamber 扩展。",
  "official-commandcode-usage": "显示每月点数、5 小时与每周限额、各模型用量和请求日志；使用从浏览器复制的会话 Cookie 登录。",
  "official-magpie-usage": "按 1、7、30 天显示网关的 Token 用量、预估费用、配额和余额；需要运行中的 Magpie 网关。",
  "alirezaghadyani-openrouter-manager": "为 OpenChamber 中每个模型控制 OpenRouter 提供商路由：价格上限、延迟、吞吐和回退。",
  "alirezaghadyani-prompt-studio": "OpenChamber 提示词库：带字段和分类的可复用模板，一键插入输入框。",
  "wx2020-openchamber-docker": "OpenChamber Docker 镜像与仅 amd64 的 GHCR 发布工作流。",
  "mel0nyrame-openchamber-context-map": "OpenChamber 的上下文地图面板：查看上一次模型请求实际发送了什么。",
  "syamsudotdev-openchamber-isolated": "在受限 Docker 容器中运行 OpenChamber 和 OpenCode，带持久化存储与资源限制。",
  "official-balance": "在侧面板和「工作状态」中显示 Command Code、StepFun 及 OpenAI 兼容中转的余额、配额和重置时间。中文界面。",
  "official-task-panel": "把项目 tasks.md 或 OpenSpec 变更文件中的复选框显示为带进度条的列表；只读。",
  "im-yuuki-opencode-dev-sandbox": "\uD83D\uDD25 你的整个工作站 \uD83D\uDDA5️ 加上 SLOP 编码智能体 \uD83D\uDCDD 全在一个容器里 \uD83D\uDCE6",
  "chaos-318-openchamber-session-usage": "OpenChamber 扩展：显示当前会话的累计 Token 用量。",
  "blackkcold-openchamber-todo-bridge": "在 OpenChamber 中以任务树和跨会话看板可视化 OpenCode v2 待办。",
  "factor-scd-openchamber-komodo": "OpenChamber 的 Komodo Core 面板：服务器、堆栈、部署、构建、仓库、流程、操作、趋势和工作状态。",
  "duc-nguyen-739-magpie-cloudshell": "在 Cloud Shell 无头环境中安装 magpie 和路由组：6 个提供商、Main/Code 分组、OpenCode + OpenChamber，附带密钥的 Web 链接；只需登录提供商。",
  "shedowe19-openchamber-deepseek-usage-de": "OpenChamber 扩展：德语界面的 DeepSeek 余额、用量及高峰/低谷计费，以欧元和柏林时间显示。",
  "official-onvtop": "GPU 负载、共享内存、温度与功耗，以及 CPU 和内存信息，并为本地 llama.cpp、Ollama、vLLM、SGLang 和 TGI 模型提供只读卡片；需要 Linux 或远程主机上的 nvstats-service 守护进程。",
  "bd7pil-reeve": "REEVE — OpenCode v2 多智能体编排：GATE 代理、回退链、账本和 OpenChamber 面板。",
  "thelast0802-opencode-workbuddy-provider": "OpenCode 的 WorkBuddy 与 CodeBuddy 提供商（支持 OpenChamber 面板）。",
  "sergiosn-opencode-harness": "opencode 执行框架：版本化全局配置、智能体、技能，以及 opencode 和 OpenChamber 启动器。",
  "cnagnn-openchamber-bin": "OpenChamber 的 Arch Linux PKGBUILD——重新打包官方预构建版本（可直接用于 AUR）。",
  "s0ya13-openchamber-github-actions": "显示当前项目 GitHub Actions 工作流运行的 OpenChamber 扩展。",
  "th3r3alduk3-mayfly": "每个浏览器会话一个临时 OpenCode 容器，以 OpenChamber 作为前端。",
  "mradwankhalil-openchamber-context-mode-stats": "OpenChamber 扩展：展示 context-mode 为 OpenCode 记录的全部数据，按会话、项目和跨运行统计；以实测值为先，context-mode 自身估算值单独标注。",
  "seanjin0513-openchamber-ai-memory": "ai-memory 的 OpenChamber 面板：服务状态和一键打开 Web 控制台。",
  "agmaonecom-sudo-opencode-on-android": "用 Termux 和 proot-distro 在 Android 手机上运行 OpenCode + OpenChamber；无需安装 App，也无需 root。",
  "official-codex-resets": "重置 OpenCode 中已连接 ChatGPT 账号的重置额度，消耗前会要求确认；会从 OpenCode 数据库读取访问令牌，并需要 sqlite3 命令。",
  "mcaimi-opencode-web-ocp": "OCP 上的简易 OpenCode Web。",
  "official-translator": "使用你配置的小模型，把粘贴的文本逐段翻译成 12 种语言，并即时翻译选中的内容。中文界面。",
  "batteryshark-galley": "在手机和桌面上私密审阅稿件，配合限定范围的写作智能体：开始一篇内容、标记重点、发送意见，并实时查看修订。",
  "maicarons-openchamber-ticket-board": "Matt Pocock 风格的 OpenChamber 工单板：工单、前沿和技能派发。",
  "thenobody0817-voice-agent": "本地 OpenChamber 实例的 Node.js 客户端：麦克风输入、转写、智能体回复和语音输出。",
  "official-argo-cd": "只读查看应用、部署历史、资源、清单、差异、日志和事件；需要服务器上已登录的 Argo CD CLI。",
  "jeanjo1310-openchamber-extension-containers": "⚠️ 个人开发中（非官方）。OpenChamber 扩展：在双运行时面板中管理 Docker 和 Podman 容器。MIT 许可——欢迎反馈和改进。",
  "official-token-plans": "阿里云百炼和小米 MiMo Token 套餐的配额条，含加油包，显示在侧栏面板和「工作状态」中；阿里云需要百炼 CLI，小米需要浏览器会话 Cookie。",
  "official-ios-simulator": "在面板中直接操作 iOS 模拟器：点击、滑动、输入、旋转和切换设备；需要 macOS、Xcode 和 serve-sim。",
  "hrzizi-openchamber-omo-orchestration-kit": "可复用的 OpenChamber + OMO 多智能体编排配置。",
  "lilitik1679-afk-openchamber-oc-bg": "为 OpenChamber Web UI 添加自定义背景壁纸和毛玻璃面板；灵感来自 HaoyueQin/deepseek-harness-background（MIT）。",
  "neoscaler-openchamber-deepseek-peak": "OpenChamber「工作状态」区块：DeepSeek 高峰/低谷徽章，以及距离下一次切换的倒计时。",
  "airtaxi-openchamber-windows-arm64": "OpenChamber 的非官方 Windows ARM64 自动构建流水线——轮询上游、构建 ARM64 NSIS 安装包、发布版本并更新 Scoop 仓库。",
  "bravo68web-openchamber-deployment": "自托管 OpenCode + OpenChamber 技术栈，集成 OhMyOpenCode。",
  "fjmrytfjsn-opencode-ecc-devcontainer": "\uD83D\uDE80 完整的 DevContainer 模板：OpenCode + ECC + OpenChamber + Tailscale 集成 | 支持移动端的远程开发环境。",
  "zoregixo865-openchamber-deepseek-peak-clock": "在「工作状态」中显示 DeepSeek 高峰／低谷计费时段，以及切换到下一时段的倒计时。",
  "derlt-openchamber-mistral-quota": "在侧栏面板中查看 Mistral API 的配额、已用额度和重置时间。"
};

// service/marketplace.ts
var OFFICIAL_URL = "https://openchamber.dev/extensions";
var GITHUB_QUERIES = [
  "https://api.github.com/search/repositories?q=topic%3Aopenchamber&per_page=100&sort=updated",
  "https://api.github.com/search/repositories?q=topic%3Aopenchamber-extension&per_page=100&sort=updated"
];
var CACHE_TTL_MS2 = 10 * 60000;
var VALIDATION_TTL_MS = 60 * 60000;
var REQUEST_TIMEOUT_MS2 = 8000;
var PACKAGE_TIMEOUT_MS = 6000;
var ICON_TIMEOUT_MS = 5000;
var VALIDATION_CONCURRENCY = 16;
var VALIDATION_BUDGET_MS = 8000;
var CACHE_FILE_VERSION = 1;
var MAX_ICON_BYTES2 = 96 * 1024;
var isRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var decodeHtml = (value) => value.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec))).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
var plainText = (html) => decodeHtml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
var attr = (tag, name) => {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return match ? decodeHtml(match[1]) : "";
};
var textBetween = (html, className) => {
  const match = html.match(new RegExp(`class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`, "i"));
  return match ? plainText(match[1]) : "";
};
var svgDataUrl = (svg) => {
  let value = svg.replace(/\sdata-astro-cid-[a-z0-9]+(?:="[^"]*")?/gi, "").trim();
  if (!/\bxmlns=/i.test(value)) {
    value = value.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return `data:image/svg+xml;base64,${Buffer.from(value, "utf8").toString("base64")}`;
};
var iconMime = (file, contentType) => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "svg" || contentType.includes("svg"))
    return "image/svg+xml";
  if (ext === "png" || contentType.includes("png"))
    return "image/png";
  if (ext === "jpg" || ext === "jpeg" || contentType.includes("jpeg"))
    return "image/jpeg";
  if (ext === "webp" || contentType.includes("webp"))
    return "image/webp";
  if (ext === "gif" || contentType.includes("gif"))
    return "image/gif";
  return "image/png";
};
var repoKey = (url) => url.trim().replace(/^git\+/, "").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
var installUrlOf = (repoUrl) => {
  const value = repoUrl.trim();
  if (!value)
    return;
  if (/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//i.test(value)) {
    return `${value.replace(/\.git$/i, "").replace(/\/+$/, "")}.git`;
  }
  if (/^git@/i.test(value))
    return value;
  if (/^https?:\/\/.+\.zip$/i.test(value))
    return value;
  return;
};
var slug = (value) => value.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "extension";
var categoryOf = (haystack, sourceCategory = "") => {
  const value = `${haystack} ${sourceCategory}`.toLowerCase();
  if (/(theme|color scheme|palette|appearance|icon pack|wallpaper|font)/.test(value)) {
    return "themes";
  }
  if (/(\bmcp\b|model context protocol|connector|tool server)/.test(value)) {
    return "mcp";
  }
  if (/(devops|workflow|monitor|usage|preview|file|agent setup|memory|provider|docker|kubernetes|terminal|prompt|search|browser|api|git|tool|integration|productivity|session|task|kanban|notes|log)/.test(value)) {
    return "tools";
  }
  return "other";
};
var parseOfficial = (html) => {
  const entries = [];
  const itemRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let match;
  while (match = itemRe.exec(html)) {
    const attrs = match[1] ?? "";
    if (!/\bdata-category=/.test(attrs))
      continue;
    const body = match[2] ?? "";
    const link = body.match(/<a\b[^>]*class="[^"]*\bext-tile\b[^"]*"[^>]*>/i);
    const href = link ? attr(link[0], "href") : "";
    if (!href)
      continue;
    const name = textBetween(body, "ext-name") || href.split("/").pop() || "Extension";
    const iconSvg = body.match(/<span[^>]*class="[^"]*\bext-icon\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1]?.match(/<svg\b[\s\S]*?<\/svg>/i)?.[0];
    const icon = iconSvg ? svgDataUrl(iconSvg) : "";
    const stars = Number(attr(attrs, "data-stars"));
    entries.push({
      name,
      description: textBetween(body, "ext-description"),
      owner: textBetween(body, "ext-owner"),
      ...icon ? { icon } : {},
      repoUrl: href,
      sourceCategory: attr(attrs, "data-category"),
      ...Number.isFinite(stars) ? { stars } : {},
      ...attr(attrs, "data-added") ? { addedAt: attr(attrs, "data-added") } : {},
      official: /class="[^"]*\bext-official\b/.test(body)
    });
  }
  return entries;
};

class MarketplaceService {
  log;
  cacheFile;
  cache = null;
  inflight = null;
  validations = new Map;
  diskLoaded = false;
  constructor(log, cacheFile) {
    this.log = log;
    this.cacheFile = cacheFile;
  }
  async get(force = false) {
    if (!this.diskLoaded)
      await this.loadDisk();
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS2) {
      return this.cache.catalog;
    }
    if (this.inflight)
      return this.inflight;
    if (!force && this.cache) {
      this.refresh().catch((error) => {
        this.log(`marketplace background refresh failed: ${this.messageOf(error)}`);
      });
      return this.cache.catalog;
    }
    try {
      return await this.refresh();
    } catch (error) {
      if (this.cache) {
        this.log(`marketplace refresh failed, serving cache: ${this.messageOf(error)}`);
        return this.cache.catalog;
      }
      throw error;
    }
  }
  async warm() {
    if (!this.diskLoaded)
      await this.loadDisk();
    if (this.inflight)
      return;
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS2)
      return;
    this.refresh().catch((error) => {
      this.log(`marketplace warm failed: ${this.messageOf(error)}`);
    });
  }
  refresh() {
    if (this.inflight)
      return this.inflight;
    this.inflight = this.build().then((catalog) => {
      this.cache = { at: Date.now(), catalog };
      this.persist();
      return catalog;
    }).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
  async loadDisk() {
    this.diskLoaded = true;
    if (!this.cacheFile)
      return;
    try {
      const text = await fsp7.readFile(this.cacheFile, "utf8");
      const data = JSON.parse(text);
      if (data.version !== CACHE_FILE_VERSION || !data.catalog || !Array.isArray(data.catalog.entries)) {
        return;
      }
      const at = Number(data.at ?? data.catalog.updatedAt ?? 0);
      this.cache = { at: Number.isFinite(at) ? at : 0, catalog: data.catalog };
      this.backfillDescriptions(data.catalog.entries);
      for (const [key, value] of Object.entries(data.validations ?? {})) {
        if (value && typeof value === "object" && typeof value.installable === "boolean") {
          this.validations.set(key, value);
        }
      }
      this.log(`marketplace cache loaded: ${data.catalog.entries.length} entries`);
    } catch {}
  }
  backfillDescriptions(entries) {
    for (const entry of entries) {
      const zh = MARKETPLACE_ZH[entry.id];
      if (zh && zh !== entry.description && !entry.descriptionZh)
        entry.descriptionZh = zh;
    }
  }
  async persist() {
    if (!this.cacheFile || !this.cache)
      return;
    const payload = {
      version: CACHE_FILE_VERSION,
      at: this.cache.at,
      catalog: this.cache.catalog,
      validations: Object.fromEntries(this.validations)
    };
    try {
      await fsp7.mkdir(path6.dirname(this.cacheFile), { recursive: true });
      const temp = `${this.cacheFile}.${process.pid}.tmp`;
      await fsp7.writeFile(temp, JSON.stringify(payload), "utf8");
      await fsp7.rename(temp, this.cacheFile);
    } catch (error) {
      this.log(`marketplace cache write failed: ${this.messageOf(error)}`);
    }
  }
  async build() {
    const errors = [];
    const [officialResult, githubResult] = await Promise.allSettled([
      this.official(),
      this.github()
    ]);
    const official = officialResult.status === "fulfilled" ? officialResult.value : [];
    if (officialResult.status === "rejected") {
      errors.push(`official: ${this.messageOf(officialResult.reason)}`);
    }
    const github = githubResult.status === "fulfilled" ? githubResult.value : [];
    if (githubResult.status === "rejected") {
      errors.push(`github: ${this.messageOf(githubResult.reason)}`);
    }
    const entries = this.merge(official, github);
    const complete = officialResult.status === "fulfilled" && githubResult.status === "fulfilled" && official.length > 0 && github.length > 0;
    if (!complete)
      this.appendCached(entries);
    await this.validate(entries, Date.now() + VALIDATION_BUDGET_MS);
    entries.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || a.name.localeCompare(b.name));
    return {
      entries,
      updatedAt: Date.now(),
      sources: {
        official: official.length,
        github: github.length,
        errors
      }
    };
  }
  async official() {
    const response = await fetch(OFFICIAL_URL, {
      headers: { "User-Agent": "openwith-matrix/2.0 (+https://openchamber.dev)" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS2)
    });
    if (!response.ok)
      throw new Error(`${OFFICIAL_URL} -> ${response.status}`);
    return parseOfficial(await response.text());
  }
  async github() {
    const token = process.env.GITHUB_TOKEN?.trim();
    const results = await Promise.allSettled(GITHUB_QUERIES.map(async (url) => {
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "openwith-matrix/2.0",
          ...token ? { Authorization: `Bearer ${token}` } : {}
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS2)
      });
      if (!response.ok)
        throw new Error(`${url} -> ${response.status}`);
      return await response.json();
    }));
    const repos = new Map;
    let failures = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failures += 1;
        this.log(`marketplace github search failed: ${this.messageOf(result.reason)}`);
        continue;
      }
      for (const repo of result.value.items ?? []) {
        if (!repo.full_name || repo.disabled || repo.fork)
          continue;
        repos.set(repo.full_name.toLowerCase(), repo);
      }
    }
    if (failures === results.length)
      throw new Error("all GitHub searches failed");
    return [...repos.values()];
  }
  appendCached(entries) {
    const cached = this.cache?.catalog.entries ?? [];
    if (!cached.length)
      return;
    const seen = new Set(entries.map((entry) => repoKey(entry.installUrl ?? entry.repoUrl ?? entry.id)));
    for (const entry of cached) {
      const key = repoKey(entry.installUrl ?? entry.repoUrl ?? entry.id);
      if (seen.has(key))
        continue;
      entries.push(entry);
      seen.add(key);
    }
  }
  merge(official, github) {
    const map = new Map;
    const byRepo = new Map;
    for (const repo of github) {
      if (!repo.full_name)
        continue;
      const key = repoKey(repo.html_url ?? `https://github.com/${repo.full_name}`);
      if (key)
        byRepo.set(key, repo);
    }
    for (const item of official) {
      const key = repoKey(item.repoUrl) || `official-${slug(item.name)}`;
      const repo = byRepo.get(key);
      const repoUrl = repo?.html_url ?? item.repoUrl;
      const installUrl = installUrlOf(repoUrl);
      const avatar = item.icon;
      const stars = Math.max(item.stars ?? 0, repo?.stargazers_count ?? 0);
      const tags = [
        ...new Set([
          ...repo?.topics ?? [],
          ...item.sourceCategory ? [item.sourceCategory] : []
        ])
      ];
      map.set(key, {
        id: slug(`official-${item.name}`),
        name: item.name,
        description: item.description || repo?.description || "",
        category: categoryOf(`${item.name} ${item.description} ${item.sourceCategory}`, item.sourceCategory),
        source: "official",
        ...item.sourceCategory ? { sourceCategory: item.sourceCategory } : {},
        ...item.official ? { official: true } : {},
        ...repoUrl ? { repoUrl } : {},
        ...repo?.homepage ? { homepageUrl: repo.homepage } : {},
        ...installUrl ? { installUrl } : {},
        ...avatar ? { avatarUrl: avatar } : {},
        ...item.owner || repo?.owner?.login ? { owner: item.owner || repo?.owner?.login } : {},
        ...stars > 0 ? { stars } : {},
        ...repo?.pushed_at || item.addedAt ? { updatedAt: repo?.pushed_at ?? item.addedAt } : {},
        ...item.addedAt ? { addedAt: item.addedAt } : {},
        ...tags.length ? { tags } : {},
        ...repo?.default_branch ? { defaultBranch: repo.default_branch } : {},
        installable: Boolean(installUrl),
        ...repo?.archived ? { archived: true } : {}
      });
      byRepo.delete(key);
    }
    for (const repo of byRepo.values()) {
      const repoUrl = repo.html_url ?? `https://github.com/${repo.full_name}`;
      const key = repoKey(repoUrl);
      const name = repo.full_name?.split("/")[1] ?? repo.full_name ?? "Extension";
      const installUrl = installUrlOf(repoUrl);
      map.set(key, {
        id: slug(repo.full_name ?? name),
        name,
        description: repo.description ?? "",
        category: categoryOf(`${name} ${repo.description ?? ""} ${(repo.topics ?? []).join(" ")}`),
        source: "github",
        ...repoUrl ? { repoUrl } : {},
        ...repo.homepage ? { homepageUrl: repo.homepage } : {},
        ...installUrl ? { installUrl } : {},
        ...repo.owner?.login ? { owner: repo.owner.login } : {},
        ...repo.stargazers_count ? { stars: repo.stargazers_count } : {},
        ...repo.pushed_at ? { updatedAt: repo.pushed_at } : {},
        ...repo.topics?.length ? { tags: repo.topics } : {},
        ...repo.default_branch ? { defaultBranch: repo.default_branch } : {},
        installable: Boolean(installUrl),
        ...repo.archived ? { archived: true } : {}
      });
    }
    const seen = new Set;
    for (const entry of map.values()) {
      let id = entry.id;
      let suffix = 2;
      while (seen.has(id)) {
        id = `${entry.id}-${suffix}`;
        suffix += 1;
      }
      seen.add(id);
      entry.id = id;
      const zh = MARKETPLACE_ZH[id];
      if (zh && zh !== entry.description)
        entry.descriptionZh = zh;
    }
    return [...map.values()];
  }
  async validate(entries, deadline = Number.POSITIVE_INFINITY) {
    const queue = entries.filter((entry) => Boolean(entry.installUrl));
    const workers = Array.from({ length: VALIDATION_CONCURRENCY }, async () => {
      for (;; ) {
        if (Date.now() > deadline)
          return;
        const entry = queue.shift();
        if (!entry)
          return;
        const info = await this.packageInfo(entry);
        entry.installable = info.installable;
        if (!entry.avatarUrl && info.icon)
          entry.avatarUrl = info.icon;
        if (!entry.avatarUrl && info.glyph)
          entry.iconGlyph = info.glyph;
      }
    });
    await Promise.all(workers);
  }
  async packageInfo(entry) {
    const match = (entry.repoUrl ?? "").match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
    if (!match)
      return { installable: false };
    const key = `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    const cached = this.validations.get(key);
    if (cached && Date.now() - cached.at < VALIDATION_TTL_MS) {
      return {
        installable: cached.installable,
        ...cached.icon ? { icon: cached.icon } : {},
        ...cached.glyph ? { glyph: cached.glyph } : {}
      };
    }
    const branches = [entry.defaultBranch, "main", "master"].filter((branch, index, all) => Boolean(branch) && all.indexOf(branch) === index);
    for (const branch of branches) {
      const base = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch.split("/").map(encodeURIComponent).join("/")}`;
      try {
        const response = await fetch(`${base}/package.json`, {
          headers: { "User-Agent": "openwith-matrix/2.0" },
          signal: AbortSignal.timeout(PACKAGE_TIMEOUT_MS)
        });
        if (!response.ok)
          continue;
        const pkg = await response.json();
        const installable = typeof pkg.version === "string" && pkg.version.trim().length > 0 && Boolean(pkg.openchamber) && typeof pkg.openchamber === "object";
        const icon = installable && !entry.avatarUrl ? await this.repoIcon(pkg, base) : undefined;
        const result = {
          installable,
          ...icon?.icon ? { icon: icon.icon } : {},
          ...icon?.glyph ? { glyph: icon.glyph } : {}
        };
        this.validations.set(key, { at: Date.now(), ...result });
        return result;
      } catch {}
    }
    this.validations.set(key, { at: Date.now(), installable: false });
    return { installable: false };
  }
  async repoIcon(pkg, base) {
    const manifest = isRecord2(pkg.openchamber) ? pkg.openchamber : undefined;
    const contributes = manifest && isRecord2(manifest.contributes) ? manifest.contributes : undefined;
    const panel = contributes && isRecord2(contributes.panel) ? contributes.panel : undefined;
    const declared = typeof panel?.icon === "string" ? panel.icon.trim() : "";
    const candidates = [];
    let glyph;
    if (declared) {
      if (/^data:/i.test(declared) || /^https?:\/\//i.test(declared))
        return { icon: declared };
      if (/\.[a-z0-9]{2,5}$/i.test(declared)) {
        candidates.push(declared.replace(/^\.?\//, ""));
      } else if (/^[a-z0-9][a-z0-9-]*$/i.test(declared)) {
        glyph = declared;
      }
    }
    candidates.push("icon.svg");
    for (const candidate of candidates) {
      try {
        const path = candidate.split("/").filter(Boolean).map(encodeURIComponent).join("/");
        const response = await fetch(`${base}/${path}`, {
          headers: { "User-Agent": "openwith-matrix/2.0" },
          signal: AbortSignal.timeout(ICON_TIMEOUT_MS)
        });
        if (!response.ok)
          continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > MAX_ICON_BYTES2)
          continue;
        const mime = iconMime(candidate, response.headers.get("content-type") ?? "");
        return { icon: `data:${mime};base64,${buffer.toString("base64")}` };
      } catch {}
    }
    return glyph ? { glyph } : {};
  }
  messageOf(error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// service/webProxy.ts
import { spawn as spawn4 } from "node:child_process";
import fsp8 from "node:fs/promises";
import os5 from "node:os";
import path7 from "node:path";
var START_TIMEOUT_MS = 15000;
var COMMAND_TIMEOUT_MS = 1e4;
var FRAME_WAIT_MS = 12000;
var counter2 = 0;
var nextId2 = () => `web-${Date.now().toString(36)}-${counter2 += 1}`;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var keyCode = (key) => {
  const named = {
    Enter: 13,
    Tab: 9,
    Backspace: 8,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    " ": 32
  };
  if (named[key] !== undefined)
    return named[key];
  if (key.length === 1)
    return key.toUpperCase().charCodeAt(0);
  return 0;
};

class BrowserController {
  settings;
  sessions = new Map;
  constructor(settings) {
    this.settings = settings;
  }
  async executable() {
    const settings = this.settings();
    for (const candidate of [settings.chromePath, settings.edgePath]) {
      if (!candidate)
        continue;
      try {
        await fsp8.access(candidate);
        return candidate;
      } catch {}
    }
    throw new Error("browser-not-found");
  }
  async start(options = {}) {
    const settings = this.settings();
    const width = options.width ?? settings.viewportWidth ?? 1280;
    const height = options.height ?? settings.viewportHeight ?? 800;
    const executable = await this.executable();
    const id = nextId2();
    const dir = path7.join(os5.tmpdir(), `openwith-browser-${id}`);
    await fsp8.mkdir(dir, { recursive: true });
    const proc = spawn4(executable, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      `--window-size=${width},${height}`,
      "about:blank"
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const session = {
      id,
      url: options.url ?? "about:blank",
      title: "",
      width,
      height,
      createdAt: Date.now(),
      proc,
      ws: null,
      dir,
      seq: 0,
      waiters: new Set,
      alive: true,
      pending: new Map,
      nextId: 1,
      stderr: ""
    };
    proc.stderr?.on("data", (chunk) => {
      session.stderr = `${session.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    proc.on("exit", () => {
      session.alive = false;
      this.rejectPending(session, "browser-exited");
      this.wake(session);
    });
    const port = await this.waitForPort(session);
    const target = await this.pageTarget(port);
    const ws = new WebSocket(target);
    session.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("browser-ws-timeout")), START_TIMEOUT_MS);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("browser-ws-error"));
      });
    });
    ws.addEventListener("message", (event) => {
      this.onMessage(session, event);
    });
    ws.addEventListener("close", () => {
      session.alive = false;
      this.rejectPending(session, "browser-disconnected");
      this.wake(session);
    });
    this.sessions.set(id, session);
    await this.send(session, "Page.enable");
    await this.send(session, "Runtime.enable");
    await this.send(session, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await this.send(session, "Page.startScreencast", {
      format: "jpeg",
      quality: settings.jpegQuality ?? 55,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1
    });
    if (session.url !== "about:blank")
      await this.navigate(id, session.url);
    return this.info(session);
  }
  list() {
    return [...this.sessions.values()].map((session) => this.info(session));
  }
  infoFor(id) {
    const session = this.sessions.get(id);
    return session ? this.info(session) : null;
  }
  async navigate(id, url) {
    const session = this.sessions.get(id);
    if (!session)
      throw new Error("unknown-browser-session");
    session.url = url;
    await this.send(session, "Page.navigate", { url });
    sleep(350).then(() => this.refreshTitle(session));
    return this.info(session);
  }
  async input(id, input) {
    const session = this.sessions.get(id);
    if (!session)
      return false;
    if (input.type === "text") {
      await this.send(session, "Input.insertText", { text: input.text });
      return true;
    }
    if (input.type === "mouse") {
      const button = input.button ?? "left";
      const common = { x: input.x, y: input.y, button, clickCount: input.clickCount ?? 1 };
      if (input.action === "move") {
        await this.send(session, "Input.dispatchMouseEvent", { type: "mouseMoved", x: input.x, y: input.y });
      } else if (input.action === "down") {
        await this.send(session, "Input.dispatchMouseEvent", { type: "mousePressed", ...common });
      } else if (input.action === "up") {
        await this.send(session, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
      } else if (input.action === "click") {
        await this.send(session, "Input.dispatchMouseEvent", { type: "mousePressed", ...common });
        await this.send(session, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
      } else {
        await this.send(session, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: input.x,
          y: input.y,
          deltaX: input.deltaX ?? 0,
          deltaY: input.deltaY ?? 0
        });
      }
      return true;
    }
    const code = input.code ?? input.key;
    const virtual = keyCode(input.key);
    const base = {
      key: input.key,
      code,
      windowsVirtualKeyCode: virtual,
      nativeVirtualKeyCode: virtual,
      modifiers: input.modifiers ?? 0,
      ...input.text ? { text: input.text } : {}
    };
    if (input.action === "down" || input.action === "press") {
      await this.send(session, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
    }
    if (input.action === "up" || input.action === "press") {
      await this.send(session, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    }
    return true;
  }
  async frame(id, since = 0, waitMs = FRAME_WAIT_MS) {
    const session = this.sessions.get(id);
    if (!session)
      return null;
    if (session.frame && session.frame.seq > since)
      return session.frame;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.waiters.delete(wake);
        resolve();
      }, waitMs);
      const wake = () => {
        clearTimeout(timer);
        session.waiters.delete(wake);
        resolve();
      };
      session.waiters.add(wake);
    });
    return session.frame && session.frame.seq > since ? session.frame : null;
  }
  async close(id) {
    const session = this.sessions.get(id);
    if (!session)
      return false;
    session.alive = false;
    try {
      session.ws.close();
    } catch {}
    this.rejectPending(session, "browser-closed");
    this.wake(session);
    this.sessions.delete(id);
    await killTree(session.proc);
    await fsp8.rm(session.dir, { recursive: true, force: true }).catch(() => {
      return;
    });
    return true;
  }
  async stopAll() {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }
  async waitForPort(session) {
    const file = path7.join(session.dir, "DevToolsActivePort");
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!session.alive)
        throw new Error(`browser-exited: ${session.stderr.trim()}`);
      try {
        const text = await fsp8.readFile(file, "utf8");
        const port = Number(text.split(/\r?\n/)[0]);
        if (Number.isFinite(port) && port > 0)
          return port;
      } catch {}
      await sleep(120);
    }
    throw new Error(`browser-start-timeout: ${session.stderr.trim()}`);
  }
  async pageTarget(port) {
    const list = await this.fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page = list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl)
      return page.webSocketDebuggerUrl;
    const created = await this.fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    if (!created.webSocketDebuggerUrl)
      throw new Error("browser-no-page-target");
    return created.webSocketDebuggerUrl;
  }
  async fetchJson(url, init) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    return await response.json();
  }
  send(session, method, params) {
    if (!session.alive)
      return Promise.reject(new Error("browser-session-closed"));
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`browser-command-timeout: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      session.pending.set(id, { resolve, reject, timer });
      session.ws.send(JSON.stringify({ id, method, ...params ? { params } : {} }));
    });
  }
  onMessage(session, event) {
    const text = typeof event.data === "string" ? event.data : String(event.data);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = session.pending.get(message.id);
      if (!pending)
        return;
      session.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new Error(message.error.message ?? "browser-command-failed"));
      else
        pending.resolve(message.result);
      return;
    }
    if (message.method === "Page.screencastFrame") {
      const params = message.params ?? {};
      const metadata = params.metadata ?? {};
      const data = String(params.data ?? "");
      if (data) {
        session.frame = {
          seq: session.seq += 1,
          mime: "image/jpeg",
          data,
          width: metadata.deviceWidth ?? session.width,
          height: metadata.deviceHeight ?? session.height,
          at: Date.now()
        };
        this.wake(session);
      }
      this.send(session, "Page.screencastFrameAck", {
        sessionId: params.sessionId
      }).catch(() => {
        return;
      });
      return;
    }
    if (message.method === "Page.loadEventFired" || message.method === "Page.frameNavigated") {
      this.refreshTitle(session);
    }
  }
  refreshTitle(session) {
    this.send(session, "Runtime.evaluate", {
      expression: "({ title: document.title, url: location.href })",
      returnByValue: true
    }).then((result) => {
      const value = result.result?.value;
      if (value?.title !== undefined)
        session.title = value.title;
      if (value?.url)
        session.url = value.url;
    }).catch(() => {
      return;
    });
  }
  wake(session) {
    for (const waiter of [...session.waiters])
      waiter();
  }
  rejectPending(session, reason) {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    session.pending.clear();
  }
  info(session) {
    return {
      id: session.id,
      url: session.url,
      title: session.title,
      width: session.width,
      height: session.height,
      alive: session.alive,
      createdAt: session.createdAt,
      frameSeq: session.seq
    };
  }
}

// service/shardxController.ts
import fsp9 from "node:fs/promises";
var REQUEST_TIMEOUT_MS3 = 6000;
var asArray = (value, key) => {
  if (Array.isArray(value))
    return value;
  if (value && typeof value === "object") {
    const nested = value[key];
    if (Array.isArray(nested))
      return nested;
  }
  return [];
};

class ShardxController {
  token(settings) {
    return process.env[settings.tokenEnv] ?? process.env.SHARDX_TOKEN ?? "";
  }
  async api(settings, route, init) {
    const base = settings.apiBase.replace(/\/+$/, "");
    const token = this.token(settings);
    const response = await fetch(`${base}${route}`, {
      ...init,
      headers: {
        ...token ? { Authorization: `Bearer ${token}` } : {},
        ...init?.body !== undefined ? { "Content-Type": "application/json" } : {},
        ...init?.headers ?? {}
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS3)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${init?.method ?? "GET"} ${route} -> ${response.status}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
  }
  async snapshot(settings, slots) {
    let profiles = [];
    let running = [];
    let error;
    try {
      const [profileAnswer, runningAnswer] = await Promise.all([
        this.api(settings, "/profiles"),
        this.api(settings, "/running")
      ]);
      profiles = asArray(profileAnswer, "profiles");
      running = asArray(runningAnswer, "running");
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const byProfile = new Map(running.map((entry) => [entry.profile_id, entry]));
    const instances = slots.map((slot, index) => {
      const profile = slot.profileId ? profiles.find((candidate) => candidate.profile_id === slot.profileId) : profiles[index];
      const profileId = profile?.profile_id ?? slot.profileId ?? null;
      const live = profileId ? byProfile.get(profileId) : undefined;
      const cdpUrl = live?.cdp?.http_url;
      return {
        id: slot.id,
        index,
        name: slot.name || profile?.name || `ShardX ${index + 1}`,
        profileId,
        running: Boolean(live),
        ...cdpUrl ? { cdpUrl } : {},
        ...slot.folder || profile?.folder ? { folder: slot.folder ?? profile?.folder } : {}
      };
    });
    return {
      online: error === undefined,
      apiBase: settings.apiBase,
      profiles,
      running,
      instances,
      expected: Math.max(settings.profileCount, slots.length),
      ...error ? { error } : {}
    };
  }
  async launch(settings) {
    try {
      await fsp9.access(settings.launcherPath);
    } catch {
      return { ok: false, error: "launcher-missing" };
    }
    if (process.env.OPENCHAMBER_OPENWITH_DRY_RUN === "1")
      return { ok: true };
    const pid = runDetached(settings.launcherPath, []);
    return pid ? { ok: true } : { ok: false, error: "spawn-failed" };
  }
  async start(settings, slots, instanceId, headless = false) {
    const instance = slots.find((slot) => slot.id === instanceId);
    if (!instance)
      return { ok: false, error: "unknown-instance" };
    const profileId = instance.profileId ?? (await this.snapshot(settings, slots)).instances.find((item) => item.id === instanceId)?.profileId ?? null;
    if (!profileId)
      return { ok: false, error: "profile-not-found" };
    try {
      await this.api(settings, `/profiles/${encodeURIComponent(profileId)}/start`, {
        method: "POST",
        body: JSON.stringify({ headless })
      });
      return { ok: true, profileId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  async stop(settings, slots, instanceId) {
    const instance = slots.find((slot) => slot.id === instanceId);
    if (!instance)
      return { ok: false, error: "unknown-instance" };
    const profileId = instance.profileId ?? (await this.snapshot(settings, slots)).instances.find((item) => item.id === instanceId)?.profileId ?? null;
    if (!profileId)
      return { ok: false, error: "profile-not-found" };
    try {
      await this.api(settings, `/profiles/${encodeURIComponent(profileId)}/stop`, {
        method: "POST"
      });
      return { ok: true, profileId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// service/terminalController.ts
import { spawn as spawn5 } from "node:child_process";
var MAX_CHUNKS2 = 600;
var MAX_BYTES3 = 512 * 1024;
var shellArgs = (shell, command, distro) => {
  if (shell === "cmd")
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command] };
  if (shell === "wsl")
    return { command: "wsl.exe", args: ["-d", distro, "--", "bash", "-lc", command] };
  if (shell === "bash")
    return { command: "bash", args: ["-lc", command] };
  const script = `$ProgressPreference='SilentlyContinue'; $OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-EncodedCommand", encoded] };
};
var sessionLaunch = (shell, distro) => {
  if (shell === "cmd")
    return { command: "cmd.exe", args: ["/Q", "/K", "chcp 65001>nul"], init: "" };
  if (shell === "wsl")
    return { command: "wsl.exe", args: ["-d", distro, "--", "bash", "-i"], init: "" };
  if (shell === "bash")
    return { command: "bash", args: ["-i"], init: "" };
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-Command", "-"],
    init: `$ProgressPreference='SilentlyContinue'\r
[Console]::OutputEncoding=[Text.Encoding]::UTF8\r
`
  };
};
var counter3 = 0;
var nextId3 = () => `term-${Date.now().toString(36)}-${counter3 += 1}`;

class TerminalController {
  defaultShell;
  defaultDistro;
  sessions = new Map;
  constructor(defaultShell, defaultDistro) {
    this.defaultShell = defaultShell;
    this.defaultDistro = defaultDistro;
  }
  async exec(input) {
    const shell = input.shell ?? this.defaultShell();
    const distro = input.distro ?? this.defaultDistro();
    const built = shellArgs(shell, input.command, distro);
    const result = await runCapture(built.command, built.args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 60000,
      maxBytes: 2 * 1024 * 1024,
      windowsHide: true
    });
    return {
      ok: result.code === 0 && !result.timedOut,
      exitCode: result.code ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut
    };
  }
  create(input = {}) {
    const shell = input.shell ?? this.defaultShell();
    const distro = input.distro ?? this.defaultDistro();
    const cwd = input.cwd ?? process.cwd();
    const launch = sessionLaunch(shell, distro);
    const child = spawn5(launch.command, launch.args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const session = {
      id: nextId3(),
      shell,
      cwd,
      ...shell === "wsl" ? { distro } : {},
      createdAt: Date.now(),
      child,
      chunks: [],
      bytes: 0,
      seq: 1,
      truncated: false,
      alive: true
    };
    this.sessions.set(session.id, session);
    if (launch.init)
      child.stdin?.write(launch.init);
    this.attach(session);
    return this.info(session);
  }
  list() {
    return [...this.sessions.values()].map((session) => this.info(session));
  }
  output(id, since = 0) {
    const session = this.sessions.get(id);
    if (!session)
      return null;
    const chunks = session.chunks.filter((chunk) => chunk.seq > since);
    return {
      chunks,
      nextSeq: session.seq,
      truncated: session.truncated || chunks.length > 0 && chunks[0].seq > since + 1,
      alive: session.alive
    };
  }
  write(id, text) {
    const session = this.sessions.get(id);
    if (!session || !session.alive)
      return false;
    const line = /[\r\n]$/.test(text) ? text : `${text}\r
`;
    session.child.stdin?.write(line);
    return true;
  }
  async stop(id) {
    const session = this.sessions.get(id);
    if (!session)
      return false;
    session.alive = false;
    await killTree(session.child);
    this.sessions.delete(id);
    return true;
  }
  async stopAll() {
    const children = [...this.sessions.values()].map((session) => session.child);
    this.sessions.clear();
    await Promise.all(children.map((child) => killTree(child)));
  }
  attach(session) {
    const push = (stream, text) => {
      if (!text)
        return;
      const chunk = { seq: session.seq, stream, text, at: Date.now() };
      session.seq += 1;
      session.chunks.push(chunk);
      session.bytes += Buffer.byteLength(text, "utf8");
      while (session.chunks.length > MAX_CHUNKS2 || session.bytes > MAX_BYTES3) {
        const dropped = session.chunks.shift();
        if (!dropped)
          break;
        session.bytes -= Buffer.byteLength(dropped.text, "utf8");
        session.truncated = true;
      }
    };
    session.child.stdout?.on("data", (chunk) => push("stdout", chunk.toString("utf8")));
    session.child.stderr?.on("data", (chunk) => push("stderr", chunk.toString("utf8")));
    session.child.on("error", (error) => {
      session.alive = false;
      push("system", `
[spawn error] ${error.message}
`);
    });
    session.child.on("exit", (code, signal) => {
      session.alive = false;
      push("system", `
[process exited code=${code ?? "-"} signal=${signal ?? "-"}]
`);
    });
  }
  info(session) {
    return {
      id: session.id,
      shell: session.shell,
      cwd: session.cwd,
      ...session.distro ? { distro: session.distro } : {},
      alive: session.alive,
      createdAt: session.createdAt
    };
  }
}

// service/variableEngine.ts
import os6 from "node:os";
import path8 from "node:path";
var branchCache = new Map;
var wslIpCache = new Map;
var BRANCH_TTL_MS = 1e4;
var WSL_IP_TTL_MS = 30000;
var gitBranch = async (directory) => {
  const cached = branchCache.get(directory);
  if (cached && Date.now() - cached.at < BRANCH_TTL_MS)
    return cached.value;
  const result = await runCapture("git", ["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeoutMs: 4000,
    maxBytes: 4096
  });
  const value = result.code === 0 ? result.stdout.trim() : "";
  branchCache.set(directory, { value, at: Date.now() });
  return value;
};
var wslIp = async (distro) => {
  if (!distro)
    return "";
  const cached = wslIpCache.get(distro);
  if (cached && Date.now() - cached.at < WSL_IP_TTL_MS)
    return cached.value;
  const result = await runCapture("wsl.exe", ["-d", distro, "--", "hostname", "-I"], {
    timeoutMs: 8000,
    maxBytes: 8192
  });
  const value = result.code === 0 ? result.stdout.trim().split(/\s+/)[0] ?? "" : "";
  wslIpCache.set(distro, { value, at: Date.now() });
  return value;
};
var pad = (value) => String(value).padStart(2, "0");
var localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
var collectEnv = (input) => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string")
      env[key] = value;
  }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (typeof value === "string")
      env[key] = value;
  }
  return env;
};
async function createVariableContext(input = {}, config) {
  const now = new Date;
  const directory = path8.resolve(input.path ?? process.cwd());
  const distro = config?.settings.wsl.distro ?? "";
  return {
    path: directory,
    winPath: input.winPath ?? toWindowsPath(directory),
    pathUrlEncode: encodeURIComponent(directory),
    projectName: path8.basename(directory),
    gitBranch: input.gitBranch ?? await gitBranch(directory),
    wslIp: input.wslIp ?? await wslIp(distro),
    host: input.host ?? os6.hostname(),
    port: String(input.port ?? 3000),
    date: localDate(now),
    now: now.toISOString(),
    env: collectEnv(input)
  };
}
function expandTemplate(template, context) {
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (match, name) => {
    if (name.startsWith("env.")) {
      const key = name.slice(4);
      return context.env[key] ?? match;
    }
    const value = context[name];
    return typeof value === "string" || typeof value === "number" ? String(value) : match;
  });
}
function expandRecord(record, context) {
  const next = {};
  for (const [key, value] of Object.entries(record))
    next[key] = expandTemplate(value, context);
  return next;
}

// service/wslController.ts
import net from "node:net";
var clean = (text) => text.replace(/\u0000/g, "").replace(/^\uFEFF/, "");
var probePort = (port, timeoutMs = 1200) => new Promise((resolve) => {
  const started = Date.now();
  const socket = net.connect({ host: "127.0.0.1", port });
  const finish = (open) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve({ open, ...open ? { latencyMs: Date.now() - started } : {} });
  };
  socket.setTimeout(timeoutMs);
  socket.once("connect", () => finish(true));
  socket.once("timeout", () => finish(false));
  socket.once("error", () => finish(false));
});
var parseDistros = (stdout) => {
  const lines = clean(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const distros = [];
  for (const line of lines) {
    if (/^NAME\s+STATE\s+VERSION/i.test(line))
      continue;
    const defaultDistro = line.startsWith("*");
    const body = defaultDistro ? line.slice(1).trim() : line;
    const parts = body.split(/\s{2,}|\t+/).filter(Boolean);
    if (parts.length < 2)
      continue;
    distros.push({
      name: parts[0] ?? "",
      state: parts[1] ?? "",
      version: parts[2] ?? "",
      default: defaultDistro
    });
  }
  return distros;
};

class WslController {
  async snapshot(settings, ports) {
    const listed = await runCapture("wsl.exe", ["-l", "-v"], {
      timeoutMs: 8000,
      maxBytes: 256 * 1024
    });
    if (listed.code !== 0) {
      return {
        available: false,
        distros: [],
        ports: ports.map((port) => ({
          id: port.id,
          label: port.label,
          port: port.port,
          protocol: port.protocol,
          open: false
        })),
        error: (clean(listed.stderr || listed.stdout) || listed.error || "wsl-unavailable").trim()
      };
    }
    const distros = parseDistros(listed.stdout);
    const distro = settings.distro || distros.find((entry) => entry.default)?.name || distros[0]?.name || "";
    let ip;
    if (distro) {
      const address = await runCapture("wsl.exe", ["-d", distro, "--", "hostname", "-I"], {
        timeoutMs: 8000,
        maxBytes: 8192
      });
      if (address.code === 0) {
        ip = clean(address.stdout).trim().split(/\s+/)[0] || undefined;
      }
    }
    const statuses = [];
    for (const port of ports) {
      const probe = await probePort(port.port);
      const url = port.protocol === "tcp" ? undefined : `${port.protocol}://localhost:${port.port}${port.path ?? "/"}`;
      statuses.push({
        id: port.id,
        label: port.label,
        port: port.port,
        protocol: port.protocol,
        open: probe.open,
        ...probe.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {},
        ...url ? { url } : {}
      });
    }
    return {
      available: true,
      distros,
      ...ip ? { ip } : {},
      ports: statuses
    };
  }
}

// service/main.ts
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var STARTED_AT = Date.now();
var MAX_BODY_BYTES = 2 * 1024 * 1024;
var PICKER_TTL_MS = 5 * 60 * 1000;
var pickers = new Map;
var OS = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
if (!PORT || !TOKEN) {
  log("missing OPENCHAMBER_SERVICE_PORT or OPENCHAMBER_SERVICE_TOKEN");
  process.exit(1);
}
var configStore = new ConfigStore;
var launcher = new HostLauncher;
var docker = new DockerController;
var k8s = new K8sController;
var wsl = new WslController;
var shardx = new ShardxController;
var guests = new GuestManager(log);
var marketplace = new MarketplaceService(log, path9.join(CONFIG_DIR, "openwith-matrix-marketplace.json"));
var terminal = new TerminalController(() => configStore.get().settings.terminalShell, () => configStore.get().settings.wsl.distro);
var logs = new LogController(() => configStore.get());
var browser = new BrowserController(() => configStore.get().settings.browser);

class HttpError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
var send = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
};
var readJson = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, "body-too-large");
    chunks.push(buffer);
  }
  if (size === 0)
    return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid-json");
  }
};
var asRecord = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
var asString = (value, fallback = "") => typeof value === "string" ? value : fallback;
var asNumber = (value, fallback) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
var health = () => ({
  status: "ok",
  version: MATRIX_VERSION,
  pid: process.pid,
  uptimeMs: Date.now() - STARTED_AT
});
var snapshot = async () => {
  const config = configStore.get();
  const errors = [];
  const settle = async (label, work, fallback) => {
    try {
      return await work;
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };
  const [guestList, apps, shardxSnapshot, wslSnapshot, dockerSnapshot, k8sSnapshot] = await Promise.all([
    settle("guests", guests.list(), []),
    settle("apps", launcher.detect(), []),
    settle("shardx", shardx.snapshot(config.settings.shardx, config.groups.win11.shardx), {
      online: false,
      apiBase: config.settings.shardx.apiBase,
      profiles: [],
      running: [],
      instances: [],
      expected: config.settings.shardx.profileCount,
      error: "unavailable"
    }),
    settle("wsl", wsl.snapshot(config.settings.wsl, config.groups.wsl.ports), {
      available: false,
      distros: [],
      ports: [],
      error: "unavailable"
    }),
    settle("docker", docker.snapshot(), {
      available: false,
      containers: [],
      error: "unavailable"
    }),
    settle("k8s", k8s.snapshot(config.settings.k8s), {
      available: false,
      contexts: [],
      pods: [],
      forwards: [],
      error: "unavailable"
    })
  ]);
  return {
    health: health(),
    config,
    guests: guestList,
    apps,
    shardx: shardxSnapshot,
    wsl: wslSnapshot,
    docker: dockerSnapshot,
    k8s: k8sSnapshot,
    errors
  };
};
var findWebhook = (id) => configStore.get().groups.cloud.webhooks.find((webhook) => webhook.id === id) ?? null;
var runWebhook = async (id, directory) => {
  const webhook = findWebhook(id);
  if (!webhook)
    throw new HttpError(404, "webhook-not-found");
  const config = configStore.get();
  const context = await createVariableContext({ path: directory }, config);
  const url = expandTemplate(webhook.url, context);
  const headers = webhook.headers ? expandRecord(webhook.headers, context) : {};
  const body = webhook.body ? expandTemplate(webhook.body, context) : undefined;
  try {
    const response = await fetch(url, {
      method: webhook.method,
      headers,
      ...body !== undefined && webhook.method !== "GET" ? { body } : {},
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, url, body: text.slice(0, 64000) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      body: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
};
var handle = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    send(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter((part) => part.length > 0).map((part) => decodeURIComponent(part));
  const [root, second, third, fourth] = parts;
  if (method === "GET" && parts.length === 1 && root === "health") {
    send(res, 200, { ...health(), ok: true });
    return;
  }
  if (root === "config") {
    if (method === "GET" && parts.length === 1) {
      send(res, 200, { ok: true, data: configStore.get(), path: CONFIG_PATH });
      return;
    }
    if (method === "PUT" && parts.length === 1) {
      const config = await configStore.save(await readJson(req));
      launcher.setApps(config.groups.win11.apps);
      send(res, 200, { ok: true, data: config });
      return;
    }
    if (method === "POST" && second === "reset") {
      const config = await configStore.reset();
      launcher.setApps(config.groups.win11.apps);
      send(res, 200, { ok: true, data: config });
      return;
    }
  }
  if (method === "GET" && root === "snapshot" && parts.length === 1) {
    send(res, 200, { ok: true, data: await snapshot() });
    return;
  }
  if (root === "marketplace") {
    if (method === "GET" && parts.length === 1) {
      const catalog = await marketplace.get(url.searchParams.get("refresh") === "1");
      send(res, 200, { ok: true, data: catalog });
      return;
    }
  }
  if (root === "guests") {
    if (method === "DELETE" && parts.length === 2 && second) {
      await guests.uninstall(second);
      send(res, 200, { ok: true, data: { id: second } });
      return;
    }
    if (method === "GET" && parts.length === 1) {
      send(res, 200, { ok: true, data: await guests.list() });
      return;
    }
    if (method === "POST" && second === "install") {
      const body = asRecord(await readJson(req));
      const installUrl = asString(body.url).trim();
      if (!installUrl)
        throw new HttpError(400, "url-required");
      send(res, 200, { ok: true, data: await guests.install(installUrl) });
      return;
    }
    if (method === "POST" && second === "updates" && third === "check") {
      const body = asRecord(await readJson(req));
      const updates = await guests.checkUpdates(body.force !== false);
      send(res, 200, { ok: true, data: { updates } });
      return;
    }
    if (second && method === "POST" && third === "update") {
      send(res, 200, { ok: true, data: await guests.update(second) });
      return;
    }
    if (second && method === "POST" && third === "frame-grant") {
      const entry = asString(asRecord(await readJson(req)).entry, "panel/index.html");
      send(res, 200, { ok: true, data: await guests.frameGrant(second, entry) });
      return;
    }
    if (second && method === "GET" && third === "service-status") {
      send(res, 200, { ok: true, data: await guests.serviceStatus(second) });
      return;
    }
    if (second && method === "POST" && third === "service-request") {
      const body = asRecord(await readJson(req));
      const request = body;
      send(res, 200, { ok: true, data: await guests.serviceRequest(second, request) });
      return;
    }
    if (second && method === "PUT" && third === "enabled") {
      const enabled = asRecord(await readJson(req)).enabled === true;
      await guests.setEnabled(second, enabled);
      send(res, 200, { ok: true, data: { id: second, enabled } });
      return;
    }
    if (second && method === "POST" && third === "storage") {
      send(res, 200, { ok: true, data: await guests.storage(second, await readJson(req)) });
      return;
    }
  }
  if (root === "apps") {
    if (method === "GET" && parts.length === 1) {
      const apps = await launcher.detect(url.searchParams.get("refresh") === "1");
      const installed = {};
      for (const app of apps)
        installed[app.id] = app.installed;
      send(res, 200, { ok: true, os: OS, installed, apps, at: Date.now() });
      return;
    }
    if (second && method === "POST" && third === "open") {
      const body = asRecord(await readJson(req));
      const directory = asString(body.directory);
      if (!path9.isAbsolute(directory))
        throw new HttpError(400, "directory-must-be-absolute");
      const result = await launcher.open(second, directory);
      send(res, result.ok ? 200 : 400, result);
      return;
    }
  }
  if (root === "pick-file" && OS !== "windows") {
    throw new HttpError(400, "pick-file-windows-only");
  }
  if (method === "POST" && root === "pick-file" && parts[1] === "start") {
    const body = asRecord(await readJson(req));
    const title = asString(body.title, "选择可执行文件");
    const filter = asString(body.filter, "可执行文件 (*.exe;*.cmd;*.bat)|*.exe;*.cmd;*.bat|所有文件 (*.*)|*.*");
    const token = randomUUID();
    const file = path9.join(os7.tmpdir(), `openwith-picker-${token}.txt`);
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `$out = '${file.replace(/'/g, "''")}'`,
      "Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue",
      "$d = New-Object System.Windows.Forms.OpenFileDialog",
      `$d.Title = '${title.replace(/'/g, "''")}'`,
      `$d.Filter = '${filter.replace(/'/g, "''")}'`,
      "$d.CheckFileExists = $true",
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [IO.File]::WriteAllText($out, $d.FileName, [Text.Encoding]::UTF8) } else { [IO.File]::WriteAllText($out, "", [Text.Encoding]::UTF8) }'
    ].join("; ");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn6("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded], {
      windowsHide: false,
      stdio: "ignore"
    });
    pickers.set(token, { file, child, startedAt: Date.now() });
    send(res, 200, { ok: true, data: { token } });
    return;
  }
  if (method === "GET" && root === "pick-file" && parts[1] === "result") {
    const token = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? "";
    const session = pickers.get(token);
    if (!session)
      throw new HttpError(404, "picker-not-found");
    if (Date.now() - session.startedAt > PICKER_TTL_MS) {
      session.child.kill();
      pickers.delete(token);
      await fsp10.rm(session.file, { force: true });
      throw new HttpError(410, "picker-expired");
    }
    try {
      const picked = await fsp10.readFile(session.file, "utf8");
      await fsp10.rm(session.file, { force: true });
      pickers.delete(token);
      send(res, 200, { ok: true, data: { pending: false, path: picked.trim() || null } });
      return;
    } catch {}
    if (session.child.exitCode !== null || session.child.killed) {
      pickers.delete(token);
      send(res, 200, { ok: true, data: { pending: false, path: null, closed: true } });
      return;
    }
    send(res, 200, { ok: true, data: { pending: true } });
    return;
  }
  if (method === "POST" && root === "open" && parts.length === 1) {
    const body = asRecord(await readJson(req));
    const directory = asString(body.directory);
    const app = asString(body.app);
    if (!path9.isAbsolute(directory))
      throw new HttpError(400, "directory-must-be-absolute");
    if (!app)
      throw new HttpError(400, "missing-app");
    const result = await launcher.open(app, directory);
    send(res, result.ok ? 200 : 400, result);
    return;
  }
  if (root === "shardx") {
    const config = configStore.get();
    if (method === "GET" && parts.length === 1) {
      send(res, 200, {
        ok: true,
        data: await shardx.snapshot(config.settings.shardx, config.groups.win11.shardx)
      });
      return;
    }
    if (method === "POST" && second === "launch" && parts.length === 2) {
      send(res, 200, { ok: true, data: await shardx.launch(config.settings.shardx) });
      return;
    }
    if (second && method === "POST" && (third === "start" || third === "stop")) {
      const result = third === "start" ? await shardx.start(config.settings.shardx, config.groups.win11.shardx, second, asRecord(await readJson(req)).headless === true) : await shardx.stop(config.settings.shardx, config.groups.win11.shardx, second);
      send(res, result.ok ? 200 : 400, { ok: result.ok, data: result, error: result.error });
      return;
    }
  }
  if (root === "wsl" && method === "GET" && parts.length === 1) {
    const config = configStore.get();
    send(res, 200, {
      ok: true,
      data: await wsl.snapshot(config.settings.wsl, config.groups.wsl.ports)
    });
    return;
  }
  if (root === "docker") {
    if (method === "GET" && parts.length === 1) {
      send(res, 200, { ok: true, data: await docker.snapshot() });
      return;
    }
    if (method === "POST" && second === "containers" && third && fourth) {
      const allowed = ["start", "stop", "restart", "kill", "pause", "unpause"];
      if (!allowed.includes(fourth)) {
        throw new HttpError(400, "invalid-action");
      }
      const result = await docker.containerAction(third, fourth);
      send(res, result.ok ? 200 : 400, { ok: result.ok, data: result });
      return;
    }
    if (method === "POST" && second === "compose" && third) {
      const allowed = ["up", "down", "ps", "restart"];
      if (!allowed.includes(third)) {
        throw new HttpError(400, "invalid-action");
      }
      const body = asRecord(await readJson(req));
      const files = Array.isArray(body.files) ? body.files.filter((file) => typeof file === "string") : configStore.get().settings.docker.composeFiles;
      const result = await docker.compose(third, files, asString(body.cwd) || undefined);
      send(res, result.ok ? 200 : 400, { ok: result.ok, data: result });
      return;
    }
  }
  if (root === "k8s") {
    if (method === "GET" && parts.length === 1) {
      send(res, 200, { ok: true, data: await k8s.snapshot(configStore.get().settings.k8s) });
      return;
    }
    if (method === "POST" && second === "forward" && parts.length === 2) {
      const body = asRecord(await readJson(req));
      const result = await k8s.startForward({
        context: asString(body.context),
        namespace: asString(body.namespace, "default"),
        pod: asString(body.pod),
        localPort: asNumber(body.localPort, 0),
        remotePort: asNumber(body.remotePort, 0)
      });
      send(res, result.running ? 200 : 400, { ok: result.running, data: result });
      return;
    }
    if (method === "DELETE" && second === "forward" && third || method === "POST" && second === "forward" && third && fourth === "stop") {
      const stopped = await k8s.stopForward(third);
      send(res, stopped ? 200 : 404, { ok: stopped, data: { id: third, stopped } });
      return;
    }
  }
  if (root === "terminal") {
    if (method === "POST" && second === "exec") {
      const body = asRecord(await readJson(req));
      const result = await terminal.exec({
        command: asString(body.command),
        shell: body.shell,
        cwd: asString(body.cwd) || undefined,
        distro: asString(body.distro) || undefined,
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined
      });
      send(res, 200, { ok: true, data: result });
      return;
    }
    if (method === "POST" && second === "sessions" && parts.length === 2) {
      const body = asRecord(await readJson(req));
      const info = terminal.create({
        shell: body.shell,
        cwd: asString(body.cwd) || undefined,
        distro: asString(body.distro) || undefined
      });
      send(res, 200, { ok: true, data: info });
      return;
    }
    if (method === "GET" && second === "sessions" && parts.length === 2) {
      send(res, 200, { ok: true, data: terminal.list() });
      return;
    }
    if (second === "sessions" && third) {
      if (method === "GET" && fourth === "output") {
        const output = terminal.output(third, asNumber(url.searchParams.get("since"), 0));
        if (!output)
          throw new HttpError(404, "session-not-found");
        send(res, 200, { ok: true, data: output });
        return;
      }
      if (method === "POST" && fourth === "input") {
        const text = asString(asRecord(await readJson(req)).text);
        const written = terminal.write(third, text);
        send(res, written ? 200 : 404, { ok: written, data: { id: third, written } });
        return;
      }
      if (method === "DELETE" && parts.length === 3) {
        const stopped = await terminal.stop(third);
        send(res, stopped ? 200 : 404, { ok: stopped, data: { id: third, stopped } });
        return;
      }
    }
  }
  if (root === "browser") {
    if (method === "POST" && second === "sessions" && parts.length === 2) {
      const body = asRecord(await readJson(req));
      const info = await browser.start({
        url: asString(body.url) || undefined,
        width: asNumber(body.width, 0) || undefined,
        height: asNumber(body.height, 0) || undefined
      });
      send(res, 200, { ok: true, data: info });
      return;
    }
    if (method === "GET" && second === "sessions" && parts.length === 2) {
      send(res, 200, { ok: true, data: browser.list() });
      return;
    }
    if (second === "sessions" && third) {
      if (method === "GET" && fourth === "frame") {
        const frame = await browser.frame(third, asNumber(url.searchParams.get("since"), 0), asNumber(url.searchParams.get("wait"), 12000));
        send(res, 200, { ok: true, data: frame });
        return;
      }
      if (method === "POST" && fourth === "navigate") {
        const target = asString(asRecord(await readJson(req)).url);
        if (!target)
          throw new HttpError(400, "missing-url");
        send(res, 200, { ok: true, data: await browser.navigate(third, target) });
        return;
      }
      if (method === "POST" && fourth === "input") {
        const body = asRecord(await readJson(req));
        const input = body.input ?? body;
        const applied = await browser.input(third, input);
        send(res, applied ? 200 : 404, { ok: applied, data: { applied } });
        return;
      }
      if (method === "DELETE" && parts.length === 3) {
        const closed = await browser.close(third);
        send(res, closed ? 200 : 404, { ok: closed, data: { id: third, closed } });
        return;
      }
    }
  }
  if (root === "logs") {
    if (method === "GET" && second === "sources" && parts.length === 2) {
      send(res, 200, { ok: true, data: await logs.sources() });
      return;
    }
    if (method === "POST" && second === "subscriptions" && parts.length === 2) {
      const sourceId = asString(asRecord(await readJson(req)).sourceId);
      send(res, 200, { ok: true, data: logs.subscribe(sourceId) });
      return;
    }
    if (method === "GET" && second === "subscriptions" && parts.length === 2) {
      send(res, 200, { ok: true, data: logs.list() });
      return;
    }
    if (second === "subscriptions" && third) {
      if (method === "GET" && fourth === "output") {
        const output = logs.output(third, asNumber(url.searchParams.get("since"), 0));
        if (!output)
          throw new HttpError(404, "subscription-not-found");
        send(res, 200, { ok: true, data: output });
        return;
      }
      if (method === "DELETE" && parts.length === 3) {
        const stopped = await logs.stop(third);
        send(res, stopped ? 200 : 404, { ok: stopped, data: { id: third, stopped } });
        return;
      }
    }
  }
  if (root === "variables") {
    if (method === "POST" && parts.length === 1) {
      const body = asRecord(await readJson(req));
      send(res, 200, {
        ok: true,
        data: await createVariableContext({
          path: asString(body.path) || undefined,
          winPath: asString(body.winPath) || undefined,
          gitBranch: asString(body.gitBranch) || undefined,
          wslIp: asString(body.wslIp) || undefined,
          host: asString(body.host) || undefined,
          port: typeof body.port === "string" || typeof body.port === "number" ? body.port : undefined
        }, configStore.get())
      });
      return;
    }
    if (method === "POST" && second === "expand" && parts.length === 2) {
      const body = asRecord(await readJson(req));
      const template = asString(body.template);
      const context = await createVariableContext({ path: asString(body.path) || undefined }, configStore.get());
      send(res, 200, { ok: true, data: { value: expandTemplate(template, context) } });
      return;
    }
  }
  if (root === "webhooks" && second && method === "POST" && third === "run") {
    const body = asRecord(await readJson(req));
    const result = await runWebhook(second, asString(body.path) || process.cwd());
    send(res, 200, { ok: true, data: result });
    return;
  }
  send(res, 404, { ok: false, error: "not-found", detail: `${method} ${url.pathname}` });
};
var server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500)
      log(`request failed: ${message}`);
    if (!res.headersSent) {
      send(res, status, { ok: false, error: status === 500 ? "internal" : message, detail: message });
    } else {
      res.end();
    }
  });
});
var shutdown = async (signal) => {
  log(`received ${signal}, shutting down`);
  server.close();
  await Promise.allSettled([
    browser.stopAll(),
    terminal.stopAll(),
    logs.stopAll(),
    k8s.stopAll()
  ]);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
var start = async () => {
  const config = await configStore.init();
  launcher.setApps(config.groups.win11.apps);
  configStore.onChange((next) => launcher.setApps(next.groups.win11.apps));
  server.listen(PORT, "127.0.0.1", () => {
    log(`openwith-matrix ${MATRIX_VERSION} listening on 127.0.0.1:${PORT}; config=${CONFIG_PATH}`);
    marketplace.warm();
  });
};
start().catch((error) => {
  log(`startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
