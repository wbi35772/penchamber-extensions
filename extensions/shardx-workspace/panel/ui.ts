import type { CdpMultiplexer } from './cdp';
import { ShardXApiClient } from './api';
import type { DiscoverResult } from './api';
import { SessionIsolationRouter } from './router';
import type { SessionSandbox } from './router';
import { OpenChamberBridge, isRunning } from './bridge';
import { WorkspaceClient } from './workspace';
import type { Assignment, Mapping, ServerStatus, Skill, SkillStep, WorkspaceState } from './workspace';
import type { Profile, Proxy, RunningProfile, TargetInfo } from './types';
import { transport } from './transport';
import { LauncherMirror } from './mirror';
import { el, clear, button, iconButton, icon, badge, toast } from './util';

type TabKind = 'console' | 'mapping' | 'skills' | 'server' | 'instance';
type AppTabKind = Exclude<TabKind, 'instance'>;
type ViewMode = 'cards' | 'list' | 'groups';
type SortKey =
  | 'manual'
  | 'name'
  | 'platform'
  | 'status'
  | 'proxy'
  | 'folder'
  | 'recent'
  | 'created'
  | 'id';

const SORT_OPTIONS: Array<[SortKey, string]> = [
  ['manual', '手动顺序'],
  ['name', '环境名称'],
  ['platform', '平台'],
  ['status', '运行状态'],
  ['proxy', '代理'],
  ['folder', '文件夹'],
  ['recent', '最近启动'],
  ['created', '创建时间'],
  ['id', '环境 ID'],
];

const APP_TABS: Record<AppTabKind, { label: string; icon: string; title: string }> = {
  console: { label: '环境', icon: 'box', title: '指纹环境列表' },
  mapping: { label: '映射', icon: 'branch', title: '实例与 Agent 会话映射' },
  skills: { label: 'Skill', icon: 'rocket', title: '可复用的浏览器操作技能' },
  server: { label: '服务器', icon: 'server', title: 'ShardX 客户端管理、同步与启动器路径' },
};

type TabRecord = {
  id: string;
  kind: TabKind;
  label: string;
  view: HTMLElement;
  sessionId: string | null;
  profileId: string | null;
  button: HTMLButtonElement | null;
};

type InstanceController = {
  sandbox: SessionSandbox;
  profile: Profile | null;
  proxy: Proxy | null;
  view: HTMLElement;
  image: HTMLImageElement;
  placeholder: HTMLElement;
  urlInput: HTMLInputElement;
  titleEl: HTMLElement;
  pagesBar: HTMLElement;
  inspector: HTMLElement;
  drawer: HTMLElement;
  telemetry: HTMLElement;
  lockBtn: HTMLButtonElement;
  detailsBtn: HTMLButtonElement;
  statusbar: HTMLElement;
  frameTimer: number | null;
  targetsTimer: number | null;
  busy: boolean;
  layout: { width: number; height: number };
  targetId: string | null;
  cdpSessionId: string | null;
  lastError: string | null;
  logCount: number;
};

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8);
}

function sessionTag(id: string): string {
  const text = id.trim();
  if (text.length <= 16) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function profileFolder(profile: Profile): string {
  return String((profile as any).folder ?? '').trim() || '未分类';
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFingerprint(profile: Profile): Record<string, any> {
  return ((profile as any).fingerprint ?? {}) as Record<string, any>;
}

function profileOs(profile: Profile): string {
  const fp = readFingerprint(profile);
  const os = (fp.os ?? {}) as Record<string, any>;
  return str(os.name ?? os.platform ?? (profile as any).platform ?? fp.platform ?? '未知');
}

function profileKernel(profile: Profile): string {
  const fp = readFingerprint(profile);
  const os = (fp.os ?? {}) as Record<string, any>;
  return str(os.kernel ?? os.version ?? os.build ?? fp.user_agent ?? '');
}

function profileCpu(profile: Profile): string {
  const fp = readFingerprint(profile);
  const nav = (fp.navigator ?? {}) as Record<string, any>;
  const value = nav.hardware_concurrency ?? nav.hardwareConcurrency ?? fp.hardware_concurrency ?? fp.cpu_cores ?? (profile as any).cpu;
  const cores = num(value);
  return cores ? `${cores} 核` : '—';
}

function profileMemory(profile: Profile): string {
  const fp = readFingerprint(profile);
  const nav = (fp.navigator ?? {}) as Record<string, any>;
  const value = nav.device_memory ?? nav.deviceMemory ?? fp.device_memory ?? (profile as any).memory;
  const gb = num(value);
  return gb ? `${gb} GB` : '—';
}

function profileTimezone(profile: Profile): string {
  const fp = readFingerprint(profile);
  return str(fp.timezone ?? fp.time_zone ?? ((fp.locale ?? {}) as any).timezone ?? '');
}

function profileNoise(profile: Profile): string {
  const fp = readFingerprint(profile);
  const noise = (fp.noise ?? {}) as Record<string, any>;
  const seed = noise.seed ?? noise.value ?? fp.noise_seed ?? fp.seed ?? (profile as any).noise_seed;
  if (seed === null || seed === undefined || seed === '') return '—';
  return str(seed).slice(0, 18);
}

function proxyProtocol(proxy: Proxy | null): 'udp' | 'tcp' | 'none' {
  if (!proxy) return 'none';
  const record = proxy as Record<string, any>;
  const protocol = str(record.protocol ?? record.type ?? record.scheme).toLowerCase();
  if (record.udp === true || record.quic === true) return 'udp';
  if (['socks5', 'socks', 'quic', 'udp', 'hysteria', 'hysteria2', 'tuic'].some((key) => protocol.includes(key))) {
    return 'udp';
  }
  if (!protocol) return 'none';
  return 'tcp';
}

function proxyLabel(proxy: Proxy | null): string {
  if (!proxy) return '直连';
  const record = proxy as Record<string, any>;
  const protocol = str(record.protocol ?? record.type ?? record.scheme).toLowerCase();
  if (!protocol) return '代理';
  if (protocol.includes('socks5') || protocol === 'socks') return 'SOCKS5';
  if (protocol.includes('http')) return 'HTTP';
  if (protocol.includes('hysteria2')) return 'Hysteria2';
  if (protocol.includes('hysteria')) return 'Hysteria';
  if (protocol.includes('tuic')) return 'TUIC';
  if (protocol.includes('wireguard')) return 'WireGuard';
  return protocol.toUpperCase();
}

function proxyText(proxy: Proxy | null): string {
  if (!proxy) return '直连（不使用代理）';
  const record = proxy as Record<string, any>;
  const host = str(record.host ?? record.server ?? record.address);
  const port = str(record.port);
  if (!host) return str(record.name ?? record.id ?? '未知代理');
  return `${host}${port ? ':' + port : ''}`;
}

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  return `https://${value}`;
}

const KEY_SPECS: Record<string, { code: string; keyCode: number; text?: string }> = {
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

function folderOf(profile: { folder?: string } | null | undefined): string {
  const folder = String(profile?.folder ?? '').trim();
  return folder || '未分类';
}

export class ShardXTabWorkspaceUI {
  private container: HTMLElement;
  private api: ShardXApiClient;
  private router: SessionIsolationRouter;
  private bridge: OpenChamberBridge;
  private sessionId: string;

  private root: HTMLElement;
  private tabBar: HTMLElement;
  private views: HTMLElement;
  private tabs = new Map<string, TabRecord>();
  private controllers = new Map<string, InstanceController>();
  private activeTabId = 'console';

  private consoleGrid!: HTMLElement;
  private consoleStats!: HTMLElement;
  private consoleError!: HTMLElement;
  private consoleApiStatus!: HTMLElement;
  private consolePanel!: HTMLElement;
  private homeBar!: HTMLElement;
  private homeSwitch!: HTMLElement;
  private homeSyncBtn!: HTMLButtonElement;
  private homeGroupsBtn!: HTMLButtonElement;
  private mirrorHost!: HTMLElement;
  private toolbarTools!: HTMLElement;
  private sessionInput!: HTMLInputElement;
  private searchInput!: HTMLInputElement;
  private platformFilter!: HTMLSelectElement;
  private homeMode: 'mirror' | 'list' = 'mirror';
  private mirror: LauncherMirror | null = null;
  private runningProfiles: RunningProfile[] = [];
  private dismissedProfiles = new Set<string>();
  private syncingRunning = false;

  private profiles: Profile[] = [];
  private proxies: Proxy[] = [];
  private viewMode: ViewMode = 'cards';
  private sortKey: SortKey = 'manual';
  private sortDir: 1 | -1 = 1;
  private sortSelect!: HTMLSelectElement;
  private sortDirBtn!: HTMLButtonElement;
  private activeFolder: string | null = null;
  private listFolder: string | null = null;
  private folderView: 'cards' | 'list' = 'cards';
  private profileOrder: Record<string, string[]> = {};
  private folderProfiles = new Map<string, Profile[]>();
  private dragProfileId: string | null = null;
  private viewSwitch!: HTMLElement;
  private workspace = new WorkspaceClient();
  private mappings: Mapping[] = [];
  private skills: Skill[] = [];
  private assignments: Assignment[] = [];
  private mappingBody!: HTMLElement;
  private mappingStats!: HTMLElement;
  private mappingSearch!: HTMLInputElement;
  private sessionOptionsEl!: HTMLDataListElement;
  private skillsList!: HTMLElement;
  private skillEditor!: HTMLElement;
  private skillLog!: HTMLPreElement;
  private skillsStats!: HTMLElement;
  private selectedSkillId: string | null = null;
  private selectedSkillTargets = new Set<string>();
  private skillsSearch!: HTMLInputElement;
  private serverBody!: HTMLElement;
  private serverStats!: HTMLElement;
  private serverStatus: ServerStatus | null = null;
  private serverPathInput!: HTMLInputElement;
  private serverSyncOutput!: HTMLElement;
  private workspaceError: string | null = null;
  private serverError: string | null = null;
  private skillCreating = false;
  private lastErrorShown = '';
  private refreshTimer: number | null = null;
  private destroyed = false;
  private discoverTried = false;
  private lastLauncherCheck = 0;
  private lastReviveAt = 0;
  private reviveInFlight = false;
  private launcherOnline = false;

  constructor(container: HTMLElement, api: ShardXApiClient, router: SessionIsolationRouter, sessionId = 'default') {
    this.container = container;
    this.api = api;
    this.router = router;
    this.sessionId = sessionId;
    try {
      const saved = window.localStorage.getItem('shardx-view-mode');
      if (saved === 'cards' || saved === 'list' || saved === 'groups') this.viewMode = saved;
      const savedFolderView = window.localStorage.getItem('shardx-folder-view');
      if (savedFolderView === 'cards' || savedFolderView === 'list') this.folderView = savedFolderView;
      const savedListFolder = window.localStorage.getItem('shardx-list-folder');
      if (savedListFolder) this.listFolder = savedListFolder;
      const savedOrder = window.localStorage.getItem('shardx-profile-order');
      if (savedOrder) {
        const parsed = JSON.parse(savedOrder) as Record<string, unknown>;
        for (const [folder, ids] of Object.entries(parsed ?? {})) {
          if (Array.isArray(ids)) this.profileOrder[folder] = ids.filter((id): id is string => typeof id === 'string');
        }
      }
      const savedHome = window.localStorage.getItem('shardx-home-mode');
      if (savedHome === 'list' || savedHome === 'mirror') this.homeMode = savedHome;
      const savedSort = window.localStorage.getItem('shardx-sort');
      if (savedSort) {
        const parsed = JSON.parse(savedSort) as Record<string, unknown>;
        if (SORT_OPTIONS.some(([key]) => key === parsed.key)) this.sortKey = parsed.key as SortKey;
        if (parsed.dir === 1 || parsed.dir === -1) this.sortDir = parsed.dir;
      }
    } catch {
      /* storage may be unavailable in a sandboxed guest */
    }
    this.bridge = new OpenChamberBridge(sessionId, api, router);

    this.root = el('div', { class: 'workspace' });
    this.tabBar = el('div', { class: 'tabbar' });
    this.views = el('div', { class: 'views' });
    this.root.append(this.tabBar, this.views);
    this.container.appendChild(this.root);

    this.buildConsoleTab();
    this.buildMappingTab();
    this.buildSkillsTab();
    this.buildServerTab();
    this.mirror = new LauncherMirror(this.mirrorHost, transport, {
      onLocalList: () => this.setHomeMode('list'),
    });
    this.applyHomeMode();
    this.renderTabBar();
    this.activateTab('console');

    this.router.onChange(() => this.onRouterChange());
    this.refreshTimer = window.setInterval(() => {
      if (this.activeTabId === 'console') void this.refreshAll(true);
    }, 10000);

    void this.refreshAll();
    void this.refreshWorkspace(true);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionId(sessionId: string): void {
    const next = sessionId.trim();
    if (!next) return;
    this.sessionId = next;
    this.bridge.setDefaultSessionId(next);
    if (this.sessionInput) this.sessionInput.value = next;
    this.renderTabBar();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.mirror?.dispose();
    this.mirror = null;
    for (const id of [...this.tabs.keys()]) this.closeTab(id, true);
    this.tabs.clear();
    this.root.remove();
  }

  // ------------------------------------------------------------------
  // Tabs
  // ------------------------------------------------------------------
  private buildConsoleTab(): void {
    const view = el('div', { class: 'main' });

    const toolbar = el('div', { class: 'toolbar' });
    const apiStatus = el('div', { class: 'api-status' });
    this.consoleApiStatus = apiStatus;
    this.consoleStats = el('div', { class: 'stats' });

    const sessionField = el('label', { class: 'inline-field' }, el('span', { text: '当前会话' }));
    this.sessionInput = el('input', {
      class: 'input session-input',
      attrs: { type: 'text', spellcheck: 'false', placeholder: 'session-id' },
      props: { value: this.sessionId },
    }) as HTMLInputElement;
    this.sessionInput.addEventListener('change', () => this.setSessionId(this.sessionInput.value));
    sessionField.appendChild(this.sessionInput);

    this.searchInput = el('input', {
      class: 'input search-input',
      attrs: { type: 'search', placeholder: '搜索名称 / ID / 文件夹' },
    }) as HTMLInputElement;
    this.searchInput.addEventListener('input', () => this.renderProfiles());

    this.platformFilter = el('select', { class: 'select platform-filter' }) as HTMLSelectElement;
    for (const [value, label] of [
      ['all', '全部平台'],
      ['win', 'Windows'],
      ['mac', 'macOS'],
      ['linux', 'Linux'],
    ]) {
      this.platformFilter.appendChild(el('option', { text: label, attrs: { value } }));
    }
    this.platformFilter.addEventListener('change', () => this.renderProfiles());

    this.sortSelect = el('select', { class: 'select sort-select', attrs: { title: '排序字段' } }) as HTMLSelectElement;
    for (const [value, label] of SORT_OPTIONS) {
      this.sortSelect.appendChild(el('option', { text: label, attrs: { value } }));
    }
    this.sortSelect.value = this.sortKey;
    this.sortSelect.addEventListener('change', () => {
      const next = this.sortSelect.value as SortKey;
      if (next === this.sortKey) this.setSort(next, this.sortDir);
      else this.setSort(next, next === 'recent' || next === 'created' ? -1 : 1);
    });

    this.sortDirBtn = button(this.sortDir === 1 ? '升序 ↑' : '降序 ↓', {
      class: 'btn small sort-dir',
      title: '切换排序方向（也可以双击表头）',
      onClick: () => {
        this.sortDir = this.sortDir === 1 ? -1 : 1;
        this.saveSort();
        this.renderProfiles();
      },
    }) as HTMLButtonElement;
    this.sortDirBtn.disabled = this.sortKey === 'manual';

    const refreshBtn = iconButton('refresh', {
      title: '刷新环境列表',
      onClick: () => void this.refreshAll(),
    });

    this.viewSwitch = el('div', { class: 'segmented view-switch' });
    this.renderViewSwitch();

    const toolbarTop = el(
      'div',
      { class: 'toolbar-row toolbar-status' },
      apiStatus,
      this.consoleStats,
      sessionField,
      el('div', { class: 'spacer' }),
      refreshBtn,
    );
    const toolbarTools = el(
      'div',
      { class: 'toolbar-row toolbar-tools' },
      this.searchInput,
      this.platformFilter,
      el('div', { class: 'spacer' }),
      this.viewSwitch,
    );
    this.toolbarTools = toolbarTools;
    toolbar.append(toolbarTop, toolbarTools);

    this.homeSwitch = el('div', { class: 'segmented home-switch' });
    this.renderHomeSwitch();
    this.homeGroupsBtn = button('本地分组', {
      class: 'btn small ghost',
      icon: 'branch',
      title: '回到本地列表：文件夹以标签页呈现，点击标签切换列表',
      onClick: () => {
        this.setHomeMode('list');
        this.setViewMode('list');
      },
    }) as HTMLButtonElement;
    this.homeSyncBtn = button('同步运行实例', {
      class: 'btn small ghost',
      icon: 'refresh',
      title: '把主界面启动、但还没有调试端口的实例重启后接管到标签页',
      onClick: () => void this.takeOverRunning(),
    }) as HTMLButtonElement;
    this.homeSyncBtn.hidden = true;
    this.homeBar = el(
      'div',
      { class: 'home-bar' },
      this.homeSwitch,
      el('div', {
        class: 'home-hint',
        text: '主界面直接镜像 ShardX 启动器本体；点一下画面后就能用鼠标和键盘操作它',
      }),
      el('div', { class: 'spacer' }),
      this.homeGroupsBtn,
      this.homeSyncBtn,
    );

    this.consoleError = el('div', { class: 'error-banner', attrs: { hidden: true } });
    this.mirrorHost = el('div', { class: 'mirror-host' });
    this.consoleGrid = el('div', { class: 'grid two' });
    if (this.viewMode !== 'cards') {
      this.consoleGrid.className = 'profile-view';
    }
    this.consolePanel = el(
      'div',
      { class: 'tab-panel panel-console' },
      this.consoleError,
      this.mirrorHost,
      this.consoleGrid,
    );

    view.append(toolbar, this.homeBar, this.consolePanel);

    this.tabs.set('console', {
      id: 'console',
      kind: 'console',
      label: '指纹环境',
      view,
      sessionId: null,
      profileId: null,
      button: null,
    });
    this.views.appendChild(view);
    this.updateApiStatus();
  }

  private renderViewSwitch(): void {
    clear(this.viewSwitch);
    const modes: Array<[ViewMode, string, string]> = [
      ['cards', '卡片', '卡片视图：信息最全'],
      ['list', '列表', '紧凑列表：一屏看更多'],
      ['groups', '分组', '按文件夹分组'],
    ];
    for (const [mode, label, title] of modes) {
      this.viewSwitch.appendChild(
        el('button', {
          class: `seg${this.viewMode === mode ? ' on' : ''}`,
          attrs: { type: 'button', title },
          text: label,
          on: { click: () => this.setViewMode(mode) },
        }),
      );
    }
  }

  private setViewMode(mode: ViewMode): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    try {
      window.localStorage.setItem('shardx-view-mode', mode);
    } catch {
      /* storage can be unavailable; the in-memory choice still applies */
    }
    this.consoleGrid.className = mode === 'cards' ? 'grid two' : 'profile-view';
    this.renderViewSwitch();
    this.renderProfiles();
  }

  private renderHomeSwitch(): void {
    clear(this.homeSwitch);
    const modes: Array<['mirror' | 'list', string, string]> = [
      ['mirror', '主界面', '镜像 ShardX 启动器自带的页面，和它完全同步'],
      ['list', '本地列表', '扩展自己的指纹环境列表，可搜索、分组和拖拽排序'],
    ];
    for (const [mode, label, title] of modes) {
      this.homeSwitch.appendChild(
        el('button', {
          class: `seg${this.homeMode === mode ? ' on' : ''}`,
          attrs: { type: 'button', title },
          text: label,
          on: { click: () => this.setHomeMode(mode) },
        }),
      );
    }
  }

  private setHomeMode(mode: 'mirror' | 'list'): void {
    if (this.homeMode === mode) return;
    this.homeMode = mode;
    try {
      window.localStorage.setItem('shardx-home-mode', mode);
    } catch {
      /* storage can be unavailable; the in-memory choice still applies */
    }
    this.applyHomeMode();
  }

  private applyHomeMode(): void {
    const mirrorOn = this.homeMode === 'mirror';
    this.renderHomeSwitch();
    if (this.toolbarTools) this.toolbarTools.hidden = mirrorOn;
    if (this.mirrorHost) this.mirrorHost.hidden = !mirrorOn;
    if (this.consoleGrid) this.consoleGrid.hidden = mirrorOn;
    if (this.consolePanel) this.consolePanel.classList.toggle('mirror-mode', mirrorOn);
    if (!mirrorOn) this.renderProfiles();
    if (this.homeGroupsBtn) this.homeGroupsBtn.hidden = !mirrorOn;
    this.updateUnsyncedNotice();
    const live = mirrorOn && this.activeTabId === 'console' && !this.destroyed;
    this.mirror?.setActive(live);
  }

  // ------------------------------------------------------------------
  // Mapping tab (profile <-> agent session <-> skill)
  // ------------------------------------------------------------------
  private buildMappingTab(): void {
    const view = el('div', { class: 'main' });

    const toolbar = el('div', { class: 'toolbar' });
    this.mappingStats = el('div', { class: 'stats' });
    this.sessionOptionsEl = el('datalist', { attrs: { id: 'shardx-session-options' } }) as HTMLDataListElement;
    this.mappingSearch = el('input', {
      class: 'input search-input',
      attrs: { type: 'search', placeholder: '搜索实例 / 会话 / Skill / 文件夹' },
    }) as HTMLInputElement;
    this.mappingSearch.addEventListener('input', () => this.renderMappings());

    const toolbarTop = el(
      'div',
      { class: 'toolbar-row toolbar-status' },
      this.mappingStats,
      el('div', { class: 'spacer' }),
      button('接管当前实例', {
        class: 'btn small',
        icon: 'branch',
        title: '把当前实例标签改绑到当前会话',
        onClick: () => void this.claimCurrentInstance(),
      }),
      iconButton('refresh', { title: '重新读取共享映射', onClick: () => void this.refreshWorkspace() }),
    );
    const toolbarTools = el(
      'div',
      { class: 'toolbar-row toolbar-tools' },
      this.mappingSearch,
      el('div', { class: 'spacer' }),
      el('span', {
        class: 'small muted',
        text: '映射写入 %APPDATA%\\shardx-workspace\\state.json，面板与 MCP 工具共用',
      }),
    );
    toolbar.append(toolbarTop, toolbarTools);

    this.mappingBody = el('div', { class: 'tab-panel mapping-panel' });
    view.append(toolbar, this.mappingBody, this.sessionOptionsEl);

    this.tabs.set('mapping', {
      id: 'mapping',
      kind: 'mapping',
      label: '会话映射',
      view,
      sessionId: null,
      profileId: null,
      button: null,
    });
    this.views.appendChild(view);
  }

  private async refreshWorkspace(silent = false): Promise<void> {
    try {
      const state = await this.workspace.load();
      this.applyWorkspace(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.workspaceError = message;
      this.renderMappings();
      this.renderSkills();
      if (!silent) toast(`读取共享映射失败：${message}`, 'error', 6000);
    }
  }

  private applyWorkspace(state: WorkspaceState): void {
    this.workspaceError = null;
    this.mappings = state.mappings;
    this.skills = state.skills;
    this.assignments = state.assignments;
    this.renderMappings();
    this.renderSkills();
  }

  private profileNameOf(profileId: string, fallback = ''): string {
    return this.profiles.find((item) => item.id === profileId)?.name || fallback || profileId;
  }

  private skillsFor(profileId: string): Skill[] {
    const profile = this.profiles.find((item) => item.id === profileId) ?? null;
    const folder = folderOf(profile);
    const ids = new Set(
      this.assignments
        .filter(
          (item) =>
            (item.target_type === 'profile' && item.target_id === profileId) ||
            (item.target_type === 'folder' && item.target_id === folder),
        )
        .map((item) => item.skill_id),
    );
    return this.skills.filter((skill) => ids.has(skill.id));
  }

  private refreshSessionOptions(): void {
    if (!this.sessionOptionsEl) return;
    clear(this.sessionOptionsEl);
    const ids = new Set<string>([this.sessionId]);
    for (const binding of this.router.bindings()) ids.add(binding.sessionId);
    for (const item of this.mappings) ids.add(item.session_id);
    for (const id of ids) this.sessionOptionsEl.appendChild(el('option', { attrs: { value: id } }));
  }

  private renderMappings(): void {
    if (!this.mappingBody) return;
    const scroll = this.mappingBody.scrollTop;
    clear(this.mappingBody);
    this.refreshSessionOptions();

    const running = this.router.bindings().filter((binding) => binding.status === 'running').length;
    if (this.mappingStats) {
      clear(this.mappingStats);
      this.mappingStats.append(
        el('span', { class: 'stat', text: `${this.mappings.length} 条映射` }),
        el('span', { class: 'stat', text: `${running} 个运行中` }),
        el('span', { class: 'stat', text: `${this.skills.length} 个 Skill` }),
        el('span', { class: 'stat', text: `${this.assignments.length} 条分配` }),
      );
    }

    if (this.workspaceError) {
      this.mappingBody.appendChild(
        el(
          'div',
          { class: 'error-banner' },
          icon('alert', 14),
          el('span', { text: this.workspaceError }),
          button('重试', { class: 'btn', onClick: () => void this.refreshWorkspace() }),
        ),
      );
    }

    const rows = new Map<string, { profileId: string; profileName: string; sessionId: string; source: string }>();
    for (const item of this.mappings) {
      rows.set(item.profile_id, {
        profileId: item.profile_id,
        profileName: item.profile_name,
        sessionId: item.session_id,
        source: item.source || 'panel',
      });
    }
    for (const binding of this.router.bindings()) {
      if (!rows.has(binding.profileId)) {
        rows.set(binding.profileId, {
          profileId: binding.profileId,
          profileName: binding.profileName,
          sessionId: binding.sessionId,
          source: '运行实例',
        });
      }
    }

    const query = (this.mappingSearch?.value ?? '').trim().toLowerCase();
    const visible = [...rows.values()].filter((row) => {
      if (!query) return true;
      const profile = this.profiles.find((item) => item.id === row.profileId);
      const skills = this.skillsFor(row.profileId)
        .map((skill) => skill.name)
        .join(' ');
      return [row.profileName, row.profileId, row.sessionId, profile ? folderOf(profile) : '', skills, row.source]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });

    if (visible.length === 0) {
      this.mappingBody.appendChild(
        el(
          'div',
          { class: 'empty' },
          icon('branch', 26),
          el('strong', { text: '还没有实例映射' }),
          el('span', {
            text: '启动一个指纹环境，或点右上角「接管当前实例」。映射会同时写入共享状态文件，Agent 通过 MCP 工具能看到同一份绑定。',
          }),
        ),
      );
      return;
    }

    const table = el('div', { class: 'map-table' });
    table.appendChild(
      el(
        'div',
        { class: 'map-row map-head' },
        el('span', { text: '实例' }),
        el('span', { text: 'Agent 会话' }),
        el('span', { text: 'Skill' }),
        el('span', { text: '操作' }),
      ),
    );
    for (const row of visible) table.appendChild(this.buildMappingRow(row));
    this.mappingBody.appendChild(table);
    this.mappingBody.scrollTop = scroll;
  }

  private buildMappingRow(row: {
    profileId: string;
    profileName: string;
    sessionId: string;
    source: string;
  }): HTMLElement {
    const profile = this.profiles.find((item) => item.id === row.profileId) ?? null;
    const name = row.profileName || profile?.name || shortId(row.profileId);
    const sandbox = this.router.getByProfile(row.profileId);
    const running = Boolean(sandbox && sandbox.cdp && sandbox.cdp.isOpen());
    const assigned = this.skillsFor(row.profileId);
    const node = el('div', { class: 'map-row' });

    node.appendChild(
      el(
        'div',
        { class: 'map-info' },
        el(
          'div',
          { class: 'map-name' },
          el('span', { class: `dot ${running ? 'ok' : 'muted'}` }),
          el('span', { text: name, title: name }),
          profile ? el('span', { class: 'small muted', text: `📁 ${folderOf(profile)}` }) : null,
        ),
        el('div', { class: 'map-sub mono', text: row.profileId, title: row.profileId }),
      ),
    );

    const sessionBox = el('div', { class: 'map-session' });
    sessionBox.appendChild(
      el('span', { class: 'mono', text: sessionTag(row.sessionId), title: row.sessionId }),
    );
    if (row.sessionId === this.sessionId) sessionBox.appendChild(badge('当前', 'info'));
    if (running && sandbox) {
      sessionBox.appendChild(badge(sandbox.status, sandbox.status === 'running' ? 'success' : 'warning'));
    } else if (row.source === '运行实例') {
      sessionBox.appendChild(badge('已停止', 'neutral'));
    }
    if (row.source && row.source !== '运行实例') {
      sessionBox.appendChild(el('span', { class: 'small muted', text: row.source }));
    }
    node.appendChild(sessionBox);

    const chips = el('div', { class: 'chips' });
    if (assigned.length === 0) chips.appendChild(el('span', { class: 'small muted', text: '未分配' }));
    for (const skill of assigned.slice(0, 4)) {
      chips.appendChild(
        el('span', {
          class: 'chip',
          text: skill.name,
          title: `${skill.site || '通用'} · ${skill.steps.length} 步`,
        }),
      );
    }
    if (assigned.length > 4) chips.appendChild(el('span', { class: 'chip', text: `+${assigned.length - 4}` }));
    node.appendChild(chips);

    const actions = el('div', { class: 'map-actions' });
    if (running) {
      actions.appendChild(
        button('打开', {
          class: 'btn small',
          icon: 'external',
          title: '打开实例视图',
          onClick: () => {
            const current = this.router.getByProfile(row.profileId);
            if (current) this.openInstanceTab(current, profile);
          },
        }),
      );
    }
    if (row.sessionId !== this.sessionId) {
      actions.appendChild(
        button('接管', {
          class: 'btn small',
          icon: 'branch',
          title: '把这个实例改绑到当前会话',
          onClick: () => void this.reassignMapping(row.profileId, row.sessionId, this.sessionId, row.profileName),
        }),
      );
    }
    const bindInput = el('input', {
      class: 'input mini',
      attrs: { type: 'text', list: 'shardx-session-options', spellcheck: 'false', placeholder: 'session-id' },
      props: { value: row.sessionId },
    }) as HTMLInputElement;
    actions.append(
      bindInput,
      iconButton('check', {
        title: '保存到该会话',
        onClick: () => void this.reassignMapping(row.profileId, row.sessionId, bindInput.value.trim(), row.profileName),
      }),
    );
    if (running && sandbox && sandbox.sessionId === this.sessionId) {
      actions.appendChild(
        iconButton('stop', {
          title: '停止实例并解除映射',
          class: 'danger-icon',
          onClick: () =>
            void this.releaseProfile(profile ?? ({ id: row.profileId, name, status: '' } as Profile)),
        }),
      );
    } else {
      actions.appendChild(
        iconButton('trash', {
          title: '删除映射（不停止实例）',
          class: 'danger-icon',
          onClick: () => void this.removeMapping(row.profileId),
        }),
      );
    }
    node.appendChild(actions);
    return node;
  }

  private async reassignMapping(
    profileId: string,
    from: string,
    to: string,
    profileName = '',
  ): Promise<void> {
    if (!to) {
      toast('会话 ID 不能为空', 'warning');
      return;
    }
    const sandbox = this.router.getByProfile(profileId);
    try {
      if (sandbox) {
        this.router.reassign(profileId, to);
        const tab = this.tabs.get(`instance:${profileId}`);
        if (tab) tab.sessionId = to;
        this.renderTabBar();
        const controller = this.controllers.get(`instance:${profileId}`);
        if (controller) this.appendLog(controller, `会话绑定改为 ${sessionTag(to)}`);
      }
      const state = await this.workspace.saveMapping(
        profileId,
        profileName || sandbox?.profileName || this.profileNameOf(profileId),
        to,
      );
      this.applyWorkspace(state);
      if (from !== to) {
        toast(`已把「${profileName || this.profileNameOf(profileId)}」绑定到会话 ${sessionTag(to)}`, 'success');
      }
    } catch (error) {
      toast(`保存映射失败：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
    }
  }

  private async removeMapping(profileId: string): Promise<void> {
    try {
      const state = await this.workspace.removeMapping(profileId);
      this.applyWorkspace(state);
      toast('已删除映射', 'success');
    } catch (error) {
      toast(`删除映射失败：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
    }
  }

  private async claimCurrentInstance(): Promise<void> {
    const controller = this.activeController();
    if (!controller) {
      toast('先打开一个实例标签，再接管', 'warning');
      return;
    }
    await this.reassignMapping(
      controller.sandbox.profileId,
      controller.sandbox.sessionId,
      this.sessionId,
      controller.sandbox.profileName,
    );
  }

  // ------------------------------------------------------------------
  // Skill tab
  // ------------------------------------------------------------------
  private buildSkillsTab(): void {
    const view = el('div', { class: 'main' });

    const toolbar = el('div', { class: 'toolbar' });
    this.skillsStats = el('div', { class: 'stats' });
    this.skillsSearch = el('input', {
      class: 'input search-input',
      attrs: { type: 'search', placeholder: '搜索 Skill 名称 / 站点 / URL 规则' },
    }) as HTMLInputElement;
    this.skillsSearch.addEventListener('input', () => this.renderSkills());

    const toolbarTop = el(
      'div',
      { class: 'toolbar-row toolbar-status' },
      this.skillsStats,
      el('div', { class: 'spacer' }),
      button('新建 Skill', {
        class: 'btn small primary',
        icon: 'plus',
        title: '把某个站点的一套操作沉淀成可复用步骤',
        onClick: () => {
          this.skillCreating = true;
          this.selectedSkillId = null;
          this.selectedSkillTargets.clear();
          this.renderSkills();
        },
      }),
      iconButton('refresh', { title: '重新读取共享 Skill 列表', onClick: () => void this.refreshWorkspace() }),
    );
    const toolbarTools = el(
      'div',
      { class: 'toolbar-row toolbar-tools' },
      this.skillsSearch,
      el('div', { class: 'spacer' }),
      el('span', {
        class: 'small muted',
        text: 'Skill 按站点沉淀步骤，可分配给实例或文件夹；面板与 MCP 使用同一份定义',
      }),
    );
    toolbar.append(toolbarTop, toolbarTools);

    const layout = el('div', { class: 'skill-layout' });
    this.skillsList = el('div', { class: 'skill-list' });
    this.skillEditor = el('div', { class: 'skill-editor' });
    layout.append(this.skillsList, this.skillEditor);

    const panel = el('div', { class: 'tab-panel skill-panel' }, layout);
    view.append(toolbar, panel);

    this.tabs.set('skills', {
      id: 'skills',
      kind: 'skills',
      label: '操作 Skill',
      view,
      sessionId: null,
      profileId: null,
      button: null,
    });
    this.views.appendChild(view);
  }

  private renderSkills(): void {
    if (!this.skillsList) return;
    const query = (this.skillsSearch?.value ?? '').trim().toLowerCase();
    const visible = this.skills.filter((skill) => {
      if (!query) return true;
      return [skill.name, skill.site, skill.url_pattern, skill.description]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });

    if (this.skillsStats) {
      clear(this.skillsStats);
      const profileTargets = new Set(
        this.assignments.filter((item) => item.target_type === 'profile').map((item) => item.target_id),
      );
      const folderTargets = new Set(
        this.assignments.filter((item) => item.target_type === 'folder').map((item) => item.target_id),
      );
      this.skillsStats.append(
        el('span', { class: 'stat', text: `${this.skills.length} 个 Skill` }),
        el('span', { class: 'stat', text: `${profileTargets.size} 个实例已分配` }),
        el('span', { class: 'stat', text: `${folderTargets.size} 个文件夹已分配` }),
      );
    }

    clear(this.skillsList);
    if (visible.length === 0) {
      this.skillsList.appendChild(
        el(
          'div',
          { class: 'empty' },
          icon('rocket', 26),
          el('strong', { text: query ? '没有匹配的 Skill' : '还没有 Skill' }),
          el('span', {
            text: query
              ? '换个关键词，或清空搜索框。'
              : '点「新建 Skill」，把某个网站的操作流程写成步骤序列，之后可批量复用。',
          }),
        ),
      );
    } else {
      for (const skill of visible) {
        const assignedCount = this.assignments.filter((item) => item.skill_id === skill.id).length;
        const item = el('div', {
          class: `skill-item${skill.id === this.selectedSkillId ? ' active' : ''}`,
          attrs: { role: 'button', tabindex: '0', title: skill.description || skill.name },
          on: {
            click: () => {
              this.skillCreating = false;
              this.selectedSkillId = skill.id;
              this.renderSkills();
            },
          },
        });
        item.appendChild(
          el(
            'div',
            { class: 'skill-item-head' },
            el('span', { class: 'skill-item-name', text: skill.name }),
            skill.site ? badge(skill.site, 'info') : null,
          ),
        );
        item.appendChild(
          el('div', {
            class: 'skill-item-sub',
            text: `${skill.steps.length} 步 · ${assignedCount} 个分配${skill.url_pattern ? ` · ${skill.url_pattern}` : ''}`,
          }),
        );
        if (skill.description) {
          item.appendChild(el('div', { class: 'skill-item-desc', text: skill.description }));
        }
        this.skillsList.appendChild(item);
      }
    }
    this.renderSkillEditor();
  }

  private renderSkillEditor(): void {
    if (!this.skillEditor) return;
    clear(this.skillEditor);

    let skill: Skill | null = null;
    if (this.skillCreating) {
      const now = Date.now();
      skill = {
        id: '',
        name: '',
        site: '',
        url_pattern: '',
        description: '',
        steps: [
          { action: 'navigate', url: 'https://TARGET/' },
          { action: 'wait', ms: 1200 },
          { action: 'extract', selector: 'body', mode: 'text' },
        ],
        created_at: now,
        updated_at: now,
      };
    } else {
      skill = this.skills.find((item) => item.id === this.selectedSkillId) ?? null;
    }

    if (!skill) {
      this.skillEditor.appendChild(
        el(
          'div',
          { class: 'empty' },
          icon('rocket', 26),
          el('strong', { text: '选择一个 Skill' }),
          el('span', { text: '左侧点选已有 Skill 进行编辑、分配或运行；也可以新建一个。' }),
        ),
      );
      return;
    }

    const current = skill;
    const head = el(
      'div',
      { class: 'skill-editor-head' },
      el('div', { class: 'skill-editor-title' }, icon('rocket', 15), el('span', { text: this.skillCreating ? '新建 Skill' : current.name })),
      el('div', { class: 'spacer' }),
      current.id ? badge(`更新于 ${new Date(current.updated_at).toLocaleString()}`, 'neutral') : badge('未保存', 'warning'),
    );

    const nameInput = el('input', {
      class: 'input',
      attrs: { type: 'text', spellcheck: 'false', placeholder: '例如：知乎登录后导出收藏' },
      props: { value: current.name },
    }) as HTMLInputElement;
    const siteInput = el('input', {
      class: 'input',
      attrs: { type: 'text', spellcheck: 'false', placeholder: '例如：zhihu.com' },
      props: { value: current.site },
    }) as HTMLInputElement;
    const patternInput = el('input', {
      class: 'input',
      attrs: { type: 'text', spellcheck: 'false', placeholder: 'URL 规则，例如：https://www.zhihu.com/collection/*' },
      props: { value: current.url_pattern },
    }) as HTMLInputElement;
    const descInput = el('input', {
      class: 'input',
      attrs: { type: 'text', spellcheck: 'false', placeholder: '这个 Skill 解决什么问题' },
      props: { value: current.description },
    }) as HTMLInputElement;
    const stepsInput = el('textarea', {
      class: 'input mono steps-input',
      attrs: { spellcheck: 'false', rows: '12' },
      props: { value: JSON.stringify(current.steps, null, 2) },
    }) as HTMLTextAreaElement;

    const field = (label: string, control: HTMLElement, hint = ''): HTMLElement => {
      const wrap = el('div', { class: 'sfield' }, el('span', { class: 'sfield-label', text: label }), control);
      if (hint) wrap.appendChild(el('span', { class: 'sfield-hint', text: hint }));
      return wrap;
    };

    const form = el(
      'div',
      { class: 'skill-form' },
      el('div', { class: 'skill-form-row' }, field('名称', nameInput), field('站点', siteInput)),
      field('URL 规则', patternInput),
      field('说明', descInput),
      field(
        '步骤（JSON 数组）',
        stepsInput,
        '支持 action：navigate / reload / wait / click / type / evaluate / extract。click/type 用 selector 或 x/y；extract 支持 mode=text|html。',
      ),
    );

    const saveBtn = button('保存 Skill', {
      class: 'btn small primary',
      icon: 'check',
      onClick: () => void this.saveSkillFromEditor(current.id, nameInput, siteInput, patternInput, descInput, stepsInput),
    });
    const deleteBtn = current.id
      ? button('删除', {
          class: 'btn small danger',
          icon: 'trash',
          onClick: async () => {
            try {
              const state = await this.workspace.removeSkill(current.id);
              this.selectedSkillId = null;
              this.skillCreating = false;
              this.applyWorkspace(state);
              toast('Skill 已删除', 'success');
            } catch (error) {
              toast(`删除失败：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
            }
          },
        })
      : null;

    const formActions = el('div', { class: 'skill-actions' }, saveBtn, deleteBtn ?? el('span'), el('div', { class: 'spacer' }));

    const assigned = this.assignments.filter((item) => item.skill_id === current.id);
    const chips = el('div', { class: 'chips' });
    if (assigned.length === 0) {
      chips.appendChild(el('span', { class: 'small muted', text: '尚未分配给任何实例或文件夹' }));
    }
    for (const item of assigned) {
      const chip = el('span', {
        class: 'chip',
        title: `${item.target_type === 'folder' ? '文件夹' : '实例'}：${item.target_id}`,
      });
      chip.appendChild(el('span', { text: `${item.target_type === 'folder' ? '📁' : '🖥'} ${item.target_id}` }));
      chip.appendChild(
        iconButton('close', {
          title: '移除这条分配',
          class: 'chip-x',
          onClick: async () => {
            try {
              this.applyWorkspace(await this.workspace.assign(current.id, item.target_type, item.target_id, true));
              toast('已移除分配', 'success');
            } catch (error) {
              toast(`移除失败：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
            }
          },
        }),
      );
      chips.appendChild(chip);
    }

    const typeSelect = el(
      'select',
      { class: 'select' },
      el('option', { text: '文件夹', attrs: { value: 'folder' } }),
      el('option', { text: '实例', attrs: { value: 'profile' } }),
    ) as HTMLSelectElement;
    const targetSelect = el('select', { class: 'select' }) as HTMLSelectElement;
    const fillTargets = (): void => {
      clear(targetSelect);
      if (typeSelect.value === 'folder') {
        const folders = new Set<string>();
        for (const profile of this.profiles) folders.add(folderOf(profile));
        for (const folder of folders) targetSelect.appendChild(el('option', { text: folder, attrs: { value: folder } }));
      } else {
        for (const profile of this.profiles) {
          targetSelect.appendChild(el('option', { text: profile.name, attrs: { value: profile.id } }));
        }
      }
    };
    typeSelect.addEventListener('change', fillTargets);
    fillTargets();

    const assignBtn = button('分配', {
      class: 'btn small',
      icon: 'plus',
      disabled: !current.id,
      title: current.id ? '把这个 Skill 分配给实例或整个文件夹' : '先保存 Skill',
      onClick: async () => {
        if (!current.id) {
          toast('先保存 Skill，再分配', 'warning');
          return;
        }
        const targetId = targetSelect.value;
        if (!targetId) {
          toast('没有可分配的目标', 'warning');
          return;
        }
        try {
          this.applyWorkspace(
            await this.workspace.assign(current.id, typeSelect.value as 'profile' | 'folder', targetId),
          );
          toast('已分配', 'success');
        } catch (error) {
          toast(`分配失败：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
        }
      },
    });

    const assignSection = el(
      'div',
      { class: 'skill-section' },
      el('div', { class: 'skill-section-head' }, icon('branch', 14), el('span', { text: '分配' })),
      chips,
      el('div', { class: 'skill-assign-row' }, typeSelect, targetSelect, assignBtn),
    );

    const running = this.router.bindings().filter((binding) => binding.status === 'running');
    const runSelect = el('select', { class: 'select skill-run-target' }) as HTMLSelectElement;
    for (const binding of running) {
      runSelect.appendChild(
        el('option', {
          text: `${binding.profileName} · ${sessionTag(binding.sessionId)}`,
          attrs: { value: binding.profileId },
        }),
      );
    }
    if (running.length === 0) runSelect.appendChild(el('option', { text: '无运行中实例', attrs: { value: '' } }));

    const log = el('pre', { class: 'skill-log mono' }) as HTMLPreElement;
    log.textContent = '运行结果会打印在这里。';
    this.skillLog = log;

    const runBtn = button('运行', {
      class: 'btn small primary',
      icon: 'play',
      title: running.length === 0 ? '先启动一个实例' : '在选中的实例上执行步骤',
      disabled: running.length === 0 || !current.id,
      onClick: () => void this.runSelectedSkill(),
    });

    const runSection = el(
      'div',
      { class: 'skill-section' },
      el(
        'div',
        { class: 'skill-section-head' },
        icon('play', 14),
        el('span', { text: '运行' }),
        el('div', { class: 'spacer' }),
        runSelect,
        runBtn,
      ),
      log,
    );

    this.skillEditor.append(head, form, formActions, assignSection, runSection);
  }

  private async saveSkillFromEditor(
    id: string,
    nameInput: HTMLInputElement,
    siteInput: HTMLInputElement,
    patternInput: HTMLInputElement,
    descInput: HTMLInputElement,
    stepsInput: HTMLTextAreaElement,
  ): Promise<void> {
    const name = nameInput.value.trim();
    if (!name) {
      toast('Skill 名称不能为空', 'warning');
      nameInput.focus();
      return;
    }
    let steps: SkillStep[];
    try {
      const parsed = JSON.parse(stepsInput.value.trim() || '[]');
      if (!Array.isArray(parsed)) throw new Error('steps 必须是数组');
      steps = parsed as SkillStep[];
    } catch (error) {
      toast(`步骤 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`, 'error', 7000);
      return;
    }
    try {
      const saved = await this.workspace.saveSkill({
        id: id || undefined,
        name,
        site: siteInput.value.trim(),
        url_pattern: patternInput.value.trim(),
        description: descInput.value.trim(),
        steps,
      });
      this.skillCreating = false;
      this.selectedSkillId = saved.skill.id;
      this.applyWorkspace(saved.state);
      toast('Skill 已保存', 'success');
    } catch (error) {
      toast(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
    }
  }

  private async runSelectedSkill(): Promise<void> {
    const skill = this.skills.find((item) => item.id === this.selectedSkillId) ?? null;
    if (!skill) {
      toast('先选择一个已保存的 Skill', 'warning');
      return;
    }
    const select = this.skillEditor?.querySelector<HTMLSelectElement>('select.skill-run-target') ?? null;
    const profileId = select?.value ?? '';
    if (!profileId) {
      toast('先选择一个运行中的实例', 'warning');
      return;
    }
    const log = this.skillLog;
    const write = (line: string): void => {
      if (!log) return;
      log.textContent += `${line}\n`;
      log.scrollTop = log.scrollHeight;
    };
    if (log) log.textContent = `▶ ${skill.name}\n实例：${this.profileNameOf(profileId)}\n`;
    try {
      const result = await this.bridge.runSkill(profileId, skill.steps as Array<Record<string, any>>);
      for (const step of result.steps) {
        const summary = step.ok === false ? `失败：${String(step.error ?? '')}` : `完成 ${JSON.stringify(step.result ?? null).slice(0, 240)}`;
        write(`[${String(step.index).padStart(2, '0')}] ${String(step.action).padEnd(8)} ${summary}`);
      }
      const failed = result.steps.some((step) => step.ok === false);
      write(failed ? '✗ 执行中断（有失败步骤）' : `✓ 执行完成，共 ${result.steps.length} 步`);
      toast(failed ? 'Skill 执行中断' : 'Skill 执行完成', failed ? 'warning' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write(`✗ ${message}`);
      toast(`运行失败：${message}`, 'error', 6000);
    }
  }

  // ------------------------------------------------------------------
  // Server tab
  // ------------------------------------------------------------------
  private buildServerTab(): void {
    const view = el('div', { class: 'main' });

    const toolbar = el('div', { class: 'toolbar' });
    this.serverStats = el('div', { class: 'stats' });
    this.serverPathInput = el('input', {
      class: 'input path-input',
      attrs: { type: 'text', spellcheck: 'false', placeholder: 'ShardX 启动器 exe 路径（留空自动发现）' },
    }) as HTMLInputElement;

    const toolbarTop = el(
      'div',
      { class: 'toolbar-row toolbar-status' },
      this.serverStats,
      el('div', { class: 'spacer' }),
      button('启动', { class: 'btn small', icon: 'play', onClick: () => void this.serverControl('start') }),
      button('停止', { class: 'btn small danger', icon: 'stop', onClick: () => void this.serverControl('stop') }),
      button('重启', { class: 'btn small', icon: 'restart', onClick: () => void this.serverControl('restart') }),
      button('同步数据', { class: 'btn small primary', icon: 'refresh', onClick: () => void this.syncServerData() }),
      iconButton('refresh', { title: '刷新服务器状态', onClick: () => void this.refreshServer() }),
    );
    const toolbarTools = el(
      'div',
      { class: 'toolbar-row toolbar-tools' },
      el('span', { class: 'small muted', text: '启动器路径' }),
      this.serverPathInput,
      button('保存路径', { class: 'btn small', onClick: () => void this.saveLauncherPath() }),
      el('div', { class: 'spacer' }),
      el('span', { class: 'small muted', text: '同步会从 ShardX API 拉取环境 / 文件夹 / 代理 / 运行中实例' }),
    );
    toolbar.append(toolbarTop, toolbarTools);

    this.serverSyncOutput = el('div', { class: 'sync-output' });
    this.serverSyncOutput.appendChild(el('div', { class: 'small muted', text: '点「同步数据」拉取一次 ShardX 数据。' }));
    this.serverBody = el('div', { class: 'tab-panel server-panel' });
    view.append(toolbar, this.serverBody);

    this.tabs.set('server', {
      id: 'server',
      kind: 'server',
      label: 'ShardX 服务器',
      view,
      sessionId: null,
      profileId: null,
      button: null,
    });
    this.views.appendChild(view);
  }

  private async refreshServer(): Promise<void> {
    if (this.serverStats) {
      clear(this.serverStats);
      this.serverStats.appendChild(el('span', { class: 'stat', text: '读取中…' }));
    }
    try {
      this.serverStatus = await this.workspace.serverStatus();
      this.serverError = null;
    } catch (error) {
      this.serverError = error instanceof Error ? error.message : String(error);
    }
    this.renderServer();
  }

  private renderServer(): void {
    if (!this.serverBody) return;
    clear(this.serverBody);
    const status = this.serverStatus;

    if (this.serverStats) {
      clear(this.serverStats);
      if (status) {
        this.serverStats.append(
          el('span', { class: `stat ${status.running ? 'ok' : ''}`, text: status.running ? '服务运行中' : '服务已停止' }),
          el('span', { class: 'stat', text: `版本 ${status.version || '未知'}` }),
          el('span', { class: 'stat info', text: `端口 ${status.port ?? '—'}` }),
          el('span', { class: `stat ${status.apiEnabled ? 'ok' : ''}`, text: status.apiEnabled ? 'API 已启用' : 'API 未启用' }),
          el('span', { class: 'stat', text: `${status.processes.length} 个进程` }),
        );
      } else {
        this.serverStats.appendChild(el('span', { class: 'stat', text: '状态未知' }));
      }
    }

    if (this.serverError) {
      this.serverBody.appendChild(
        el(
          'div',
          { class: 'error-banner' },
          icon('alert', 14),
          el('span', { text: this.serverError }),
          button('重试', { class: 'btn', onClick: () => void this.refreshServer() }),
        ),
      );
    }

    if (!status) {
      this.serverBody.appendChild(
        el(
          'div',
          { class: 'empty' },
          icon('server', 26),
          el('strong', { text: '还没有读到服务器状态' }),
          el('span', { text: '点右上角刷新，或检查桥接服务是否运行。' }),
        ),
      );
      return;
    }

    if (this.serverPathInput && document.activeElement !== this.serverPathInput) {
      this.serverPathInput.value = status.launcherPath || '';
      this.serverPathInput.placeholder = status.launcherPath
        ? status.launcherPath
        : 'ShardX 启动器 exe 路径（留空自动发现）';
    }

    const grid = el('div', { class: 'server-grid' });
    const card = (title: string, iconName: string, body: HTMLElement, tone = ''): HTMLElement => {
      const node = el(
        'div',
        { class: `server-card ${tone}` },
        el('div', { class: 'server-card-head' }, icon(iconName, 14), el('span', { text: title })),
      );
      node.appendChild(body);
      return node;
    };
    const kv = (): HTMLElement => el('div', { class: 'kv' });
    const addRow = (parent: HTMLElement, key: string, value: string, tone = ''): void => {
      parent.append(
        el('span', { class: 'k', text: key }),
        el('span', { class: `v mono ${tone}`, text: value || '—', title: value }),
      );
    };

    const statusKv = kv();
    addRow(statusKv, '安装发现', status.found ? '已找到' : '未找到', status.found ? 'ok' : 'err');
    addRow(statusKv, '运行状态', status.running ? '运行中' : '已停止', status.running ? 'ok' : '');
    addRow(statusKv, '版本', status.version || '未知');
    addRow(statusKv, 'API 端口', status.port ? String(status.port) : '');
    addRow(statusKv, 'API 开关', status.apiEnabled ? '已启用' : '未启用', status.apiEnabled ? 'ok' : 'warn');
    addRow(statusKv, '数据目录', status.dataRoot || '');
    addRow(statusKv, '设置文件', status.settingsPath || '');
    addRow(statusKv, '共享状态', status.statePath || '');
    addRow(statusKv, '启动器', status.launcherPath || '');

    const processBody = el('div', { class: 'process-list' });
    if (status.processes.length === 0) {
      processBody.appendChild(el('div', { class: 'small muted', text: '未发现运行中的 ShardX 进程。' }));
    } else {
      for (const item of status.processes) {
        processBody.appendChild(
          el(
            'div',
            { class: 'process-row' },
            el('span', { class: 'pid mono', text: `PID ${item.pid}` }),
            el('span', { class: 'process-path mono', text: item.path || '—', title: item.path }),
          ),
        );
      }
    }

    const syncBody = el('div', { class: 'sync-body' });
    syncBody.appendChild(this.serverSyncOutput);
    syncBody.appendChild(
      el('div', {
        class: 'small muted',
        text: '同步只读取 ShardX API；不会修改环境、代理或文件夹配置。',
      }),
    );

    grid.append(
      card('服务状态', 'server', statusKv, status.running ? 'ok' : ''),
      card('进程', 'terminal', processBody),
      card('数据同步', 'refresh', syncBody),
    );
    this.serverBody.appendChild(grid);

    if (!status.found) {
      this.serverBody.appendChild(
        el(
          'div',
          { class: 'server-hint' },
          icon('info', 14),
          el('span', {
            text: '没找到 ShardX 安装。可在上方填入启动器 exe 的完整路径并保存，再点启动。',
          }),
        ),
      );
    }
  }

  private async saveLauncherPath(): Promise<void> {
    const path = this.serverPathInput?.value.trim() ?? '';
    try {
      await this.workspace.saveSettings({ launcher_path: path });
      toast('启动器路径已保存', 'success');
      void this.refreshServer();
    } catch (error) {
      toast(`保存路径失败：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
    }
  }

  private async serverControl(action: 'start' | 'stop' | 'restart'): Promise<void> {
    const path = this.serverPathInput?.value.trim() ?? '';
    toast(action === 'start' ? '正在启动 ShardX…' : action === 'stop' ? '正在停止 ShardX…' : '正在重启 ShardX…', 'info', 2200);
    try {
      this.serverStatus = await this.workspace.serverControl(action, path);
      this.serverError = null;
      this.renderServer();
      toast('操作完成', 'success');
      void this.refreshServer();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.serverError = message;
      this.renderServer();
      toast(`操作失败：${message}`, 'error', 7000);
    }
  }

  private async syncServerData(): Promise<void> {
    if (this.serverSyncOutput) {
      clear(this.serverSyncOutput);
      this.serverSyncOutput.appendChild(el('div', { class: 'small muted', text: '正在同步…' }));
    }
    try {
      const result = await this.workspace.syncServer();
      if (this.serverSyncOutput) {
        clear(this.serverSyncOutput);
        this.serverSyncOutput.appendChild(
          el(
            'div',
            { class: 'sync-summary' },
            badge(`${result.profileCount} 个环境`, 'info'),
            badge(`${result.folderCount} 个文件夹`, 'neutral'),
            badge(`${result.proxyCount} 个代理`, 'neutral'),
            badge(`${result.runningCount} 个运行中`, 'success'),
          ),
        );
        const time = el('div', {
          class: 'small muted',
          text: `同步时间 ${new Date(result.syncedAt).toLocaleString()} · 版本 ${result.version || '未知'} · 端口 ${result.port ?? '—'}`,
        });
        this.serverSyncOutput.appendChild(time);
        const folders = el('div', { class: 'chips sync-chips' });
        for (const folder of result.folders.slice(0, 12)) {
          const name =
            typeof folder === 'string'
              ? folder
              : String(folder?.name ?? folder?.folder ?? folder?.id ?? '');
          if (name) folders.appendChild(el('span', { class: 'chip', text: name }));
        }
        if (result.folders.length > 12) {
          folders.appendChild(el('span', { class: 'chip', text: `+${result.folders.length - 12}` }));
        }
        this.serverSyncOutput.appendChild(folders);
      }
      toast('同步完成', 'success');
      void this.refreshAll(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.serverSyncOutput) {
        clear(this.serverSyncOutput);
        this.serverSyncOutput.appendChild(el('div', { class: 'small err', text: `同步失败：${message}` }));
      }
      toast(`同步失败：${message}`, 'error', 7000);
    }
  }

  private renderTabBar(): void {
    clear(this.tabBar);

    const strip = el('div', { class: 'tabstrip' });
    let instanceSeparator = false;
    for (const record of this.tabs.values()) {
      if (record.kind === 'instance' && !instanceSeparator) {
        strip.appendChild(el('span', { class: 'tab-sep' }));
        instanceSeparator = true;
      }
      const active = record.id === this.activeTabId;
      if (record.kind !== 'instance') {
        const meta = APP_TABS[record.kind];
        const button = el('button', {
          class: `tab app-tab${active ? ' active' : ''}`,
          attrs: { type: 'button', title: meta.title },
          on: { click: () => this.activateTab(record.id) },
        });
        button.appendChild(el('span', { class: `tab-favicon app ${record.kind}` }, icon(meta.icon, 13)));
        button.appendChild(el('span', { class: 'tab-label', text: meta.label }));
        record.button = button;
        strip.appendChild(button);
        continue;
      }

      const button = el('button', {
        class: `tab${active ? ' active' : ''}`,
        attrs: {
          type: 'button',
          title: `${record.label}${record.sessionId ? `\n会话 ${record.sessionId}` : ''}\n双击关闭标签（不会停止实例）`,
        },
        on: { click: () => this.activateTab(record.id) },
      });

      const controller = this.controllers.get(record.id);
      const proxyKind = proxyProtocol(controller?.proxy ?? null);
      button.appendChild(
        el('span', {
          class: `tab-favicon ${proxyKind === 'udp' ? 'udp' : proxyKind === 'tcp' ? 'tcp' : 'direct'}`,
          title:
            proxyKind === 'udp'
              ? '代理协议：UDP / QUIC'
              : proxyKind === 'tcp'
                ? '代理协议：TCP'
                : '直连，无代理',
          text: (record.label || '?').trim().slice(0, 1).toUpperCase(),
        }),
      );
      button.appendChild(el('span', { class: 'tab-label', text: record.label }));
      const close = el('span', {
        class: 'close',
        text: '×',
        title: '关闭标签（不停止实例）',
        on: {
          click: (event: MouseEvent) => {
            event.stopPropagation();
            this.closeTab(record.id);
          },
        },
      });
      button.appendChild(close);
      button.addEventListener('dblclick', (event) => {
        event.preventDefault();
        this.closeTab(record.id);
      });

      record.button = button;
      strip.appendChild(button);
    }

    strip.appendChild(el('div', { class: 'spacer' }));
    strip.appendChild(
      iconButton('plus', {
        title: '新建并启动实例',
        class: 'tab-action',
        onClick: () => this.openCreateDialog(),
      }),
    );
    strip.appendChild(
      iconButton('settings', {
        title: 'API 端口与 Token 设置',
        class: 'tab-action',
        onClick: () => this.openSettings(),
      }),
    );

    this.tabBar.appendChild(strip);
  }

  private activateTab(id: string): void {
    const record = this.tabs.get(id);
    if (!record) return;
    this.activeTabId = id;
    for (const [tabId, tab] of this.tabs) {
      tab.view.style.display = tabId === id ? 'flex' : 'none';
      tab.button?.classList.toggle('active', tabId === id);
    }
    if (record.kind === 'console') {
      if (this.homeMode === 'mirror') this.mirror?.setActive(true);
      void this.refreshAll(true);
    } else {
      this.mirror?.setActive(false);
      if (record.kind === 'mapping' || record.kind === 'skills') void this.refreshWorkspace(true);
      else if (record.kind === 'server') void this.refreshServer();
      else {
        const controller = this.controllers.get(id);
        if (controller) void this.refreshFrame(controller, true);
      }
    }
  }

  private closeTab(id: string, silent = false): void {
    const record = this.tabs.get(id);
    if (!record || record.kind !== 'instance') return;
    const controller = this.controllers.get(id);
    if (controller) {
      if (controller.frameTimer !== null) window.clearInterval(controller.frameTimer);
      if (controller.targetsTimer !== null) window.clearInterval(controller.targetsTimer);
      this.controllers.delete(id);
    }
    record.view.remove();
    this.tabs.delete(id);
    if (!silent && record.profileId) this.dismissedProfiles.add(record.profileId);
    if (this.activeTabId === id) {
      this.activeTabId = 'console';
      this.activateTab('console');
    }
    this.renderTabBar();
    if (!silent) toast('标签已关闭（实例仍在运行，可在控制台重新打开）', 'info');
  }

  private openInstanceTab(sandbox: SessionSandbox, profile: Profile | null, activate = true): void {
    const id = `instance:${sandbox.profileId}`;
    const existing = this.tabs.get(id);
    if (existing) {
      if (activate) this.activateTab(id);
      return;
    }

    const controller = this.buildInstanceView(sandbox, profile);
    this.controllers.set(id, controller);
    this.tabs.set(id, {
      id,
      kind: 'instance',
      label: profile?.name || sandbox.profileName || shortId(sandbox.profileId),
      view: controller.view,
      sessionId: sandbox.sessionId,
      profileId: sandbox.profileId,
      button: null,
    });
    this.views.appendChild(controller.view);
    this.renderTabBar();
    if (activate) this.activateTab(id);
    void this.saveInstanceMapping(sandbox);
  }

  private async saveInstanceMapping(sandbox: SessionSandbox): Promise<void> {
    try {
      const state = await this.workspace.saveMapping(
        sandbox.profileId,
        sandbox.profileName || sandbox.profileId,
        sandbox.sessionId,
      );
      this.applyWorkspace(state);
    } catch (error) {
      console.warn('[ShardX] 写入映射失败', error);
    }
  }

  // ------------------------------------------------------------------
  // Console
  // ------------------------------------------------------------------
  private updateApiStatus(): void {
    const node = this.consoleApiStatus;
    if (!node) return;
    clear(node);
    const dot = el('span', { class: 'dot ok' });
    node.append(
      dot,
      el('span', { class: 'mono', text: `API ${this.api.baseUrl()}` }),
      el('span', { class: 'small', text: this.api.hasToken() ? 'Bearer 已配置' : '无 Token' }),
    );
  }

  private setConsoleError(message: string | null): void {
    if (!this.consoleError) return;
    if (!message) {
      this.consoleError.setAttribute('hidden', '');
      this.consoleError.textContent = '';
      return;
    }
    this.consoleError.removeAttribute('hidden');
    clear(this.consoleError);
    this.consoleError.append(
      icon('alert', 14),
      el('span', { text: message }),
      button('打开设置', { class: 'btn', onClick: () => this.openSettings() }),
    );
  }

  /**
   * Keep the launcher reachable across host reloads.
   *
   * A stored bearer used to skip discovery entirely, so a launcher closed while
   * OpenChamber restarted left every API call failing until it was opened by
   * hand. Discovery is cheap (settings read + health probe); when it reports the
   * launcher is down, the bridge starts it again without asking for a path.
   */
  private async autoDiscover(): Promise<void> {
    if (this.reviveInFlight) return;
    const now = Date.now();
    if (this.discoverTried && now - this.lastLauncherCheck < 20000) return;
    this.discoverTried = true;
    this.lastLauncherCheck = now;
    let info: DiscoverResult;
    try {
      info = await this.api.discover();
    } catch (error) {
      console.warn('[ShardX] 自动检测失败', error);
      return;
    }
    if (!info?.found) return;
    await this.api.applyDiscovered(info).catch((error) => {
      console.warn('[ShardX] 应用自动检测结果失败', error);
    });
    this.updateApiStatus();
    if (info.running !== false) {
      if (!this.launcherOnline) {
        this.launcherOnline = true;
        toast(`已自动连接 ShardX${info.version ? ` ${info.version}` : ''}（端口 ${info.port}）`, 'success', 4000);
      }
      return;
    }
    this.launcherOnline = false;
    await this.reviveLauncher();
  }

  /** Start the launcher once when discovery says it is not running. */
  private async reviveLauncher(): Promise<void> {
    if (this.reviveInFlight) return;
    if (Date.now() - this.lastReviveAt < 30000) return;
    this.reviveInFlight = true;
    this.lastReviveAt = Date.now();
    try {
      const path = this.serverPathInput?.value.trim() ?? '';
      const status = await this.workspace.serverControl('start', path);
      if (status?.running) {
        const fresh = await this.api.discover().catch(() => null);
        if (fresh?.found) await this.api.applyDiscovered(fresh).catch(() => undefined);
        this.launcherOnline = true;
        this.updateApiStatus();
        toast(`ShardX 未运行，已自动启动${fresh?.version ? ` ${fresh.version}` : ''}`, 'success', 4000);
        return;
      }
      toast('ShardX 未运行，自动启动未成功，请到「服务器」页检查启动器路径', 'warning', 6000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(`ShardX 未运行，自动启动失败：${message}`, 'warning', 6000);
    } finally {
      this.reviveInFlight = false;
    }
  }

  private unsyncedRunning(): RunningProfile[] {
    return this.runningProfiles.filter((item) => {
      if (item.cdpWebSocketDebuggerUrl) return false;
      if (this.dismissedProfiles.has(item.profileId)) return false;
      const owner = this.router.owner(item.profileId);
      return !owner || owner === this.sessionId;
    });
  }

  private updateUnsyncedNotice(): void {
    if (!this.homeSyncBtn) return;
    const count = this.unsyncedRunning().length;
    this.homeSyncBtn.hidden = count === 0 || this.homeMode !== 'mirror';
    this.homeSyncBtn.textContent = `接管 ${count} 个运行实例`;
    this.homeSyncBtn.title =
      '这些实例由 ShardX 主界面直接启动，没有调试端口。点击会重启它们（原窗口关闭）并镜像到标签页。';
  }

  /**
   * Browsers launched by the launcher window are not started with a CDP port.
   * Restart each one through the launcher API (which adds the debugging flags)
   * so it can be mirrored into its own tab.
   */
  private async takeOverRunning(): Promise<void> {
    const targets = this.unsyncedRunning();
    if (targets.length === 0) return;
    if (this.syncingRunning) return;
    this.syncingRunning = true;
    let taken = 0;
    try {
      for (const item of targets) {
        if (this.destroyed) break;
        const profile = this.profiles.find((candidate) => candidate.id === item.profileId) ?? null;
        const name = profile?.name || item.profileId;
        try {
          await this.api.stopProfile(item.profileId).catch(() => null);
          await new Promise<void>((resolve) => window.setTimeout(resolve, 400));
          const sandbox = await this.bridge.startSessionProfile(this.sessionId, item.profileId, name);
          this.dismissedProfiles.delete(item.profileId);
          this.openInstanceTab(sandbox, profile, false);
          taken += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toast(`接管 ${name} 失败：${message}`, 'error', 6000);
        }
      }
    } finally {
      this.syncingRunning = false;
    }
    if (taken > 0) toast(`已接管 ${taken} 个运行实例`, 'success', 2600);
    await this.refreshAll(true);
  }

  async refreshAll(silent = false): Promise<void> {
    if (this.destroyed) return;
    await this.autoDiscover();
    try {
      const [profiles, proxies, running] = await Promise.all([
        this.api.profiles(),
        this.api.proxies(),
        this.api.running().catch(() => [] as RunningProfile[]),
      ]);
      this.profiles = profiles;
      this.proxies = proxies;
      this.runningProfiles = running;
      this.updateUnsyncedNotice();
      this.setConsoleError(null);
      this.updateApiStatus();
      this.renderProfiles();
      void this.syncRunningTabs();
      if (!silent) toast(`已加载 ${profiles.length} 个指纹环境`, 'success', 2200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setConsoleError(message);
      this.updateStats();
      if (!silent && message !== this.lastErrorShown) {
        toast(message, 'error', 6000);
      }
      this.lastErrorShown = message;
    }
  }

  /**
   * Every browser ShardX reports as running gets an instance tab. The tab is
   * opened in the background so the current view (usually the launcher mirror)
   * does not jump; a tab the user closed is remembered until that browser stops.
   */
  private async syncRunningTabs(): Promise<void> {
    if (this.destroyed || this.syncingRunning) return;
    this.syncingRunning = true;
    try {
      const runningIds = new Set(this.runningProfiles.map((item) => item.profileId));
      for (const profileId of [...this.dismissedProfiles]) {
        if (!runningIds.has(profileId)) this.dismissedProfiles.delete(profileId);
      }
      for (const item of this.runningProfiles) {
        if (this.destroyed) return;
        if (!item.cdpWebSocketDebuggerUrl) continue;
        const tabId = `instance:${item.profileId}`;
        if (this.tabs.has(tabId) || this.dismissedProfiles.has(item.profileId)) continue;
        if (this.tabs.size >= 18) break;
        const owner = this.router.owner(item.profileId);
        if (owner && owner !== this.sessionId) continue;
        const profile = this.profiles.find((candidate) => candidate.id === item.profileId) ?? null;
        try {
          const sandbox = await this.bridge.attachRunningProfile(
            this.sessionId,
            item.profileId,
            profile?.name ?? item.profileId,
            item.cdpWebSocketDebuggerUrl,
          );
          this.openInstanceTab(sandbox, profile, false);
        } catch (error) {
          console.warn('[ShardX] 接管运行中的实例失败', item.profileId, error);
        }
      }
    } finally {
      this.syncingRunning = false;
      this.updateUnsyncedNotice();
    }
  }

  /**
   * Reuse an already-running browser instead of asking ShardX to start it
   * again. A second start is rejected by the launcher, so every caller that
   * wants "this profile in this session" goes through here.
   */
  private async attachOrStart(profile: Profile, sessionId: string): Promise<SessionSandbox> {
    const name = profile.name || profile.id;
    const known = this.runningProfiles.find((item) => item.profileId === profile.id);
    if (known?.cdpWebSocketDebuggerUrl) {
      this.dismissedProfiles.delete(profile.id);
      return this.bridge.attachRunningProfile(sessionId, profile.id, name, known.cdpWebSocketDebuggerUrl);
    }
    if (isRunning(profile)) {
      const fresh = await this.api.running().catch(() => [] as RunningProfile[]);
      this.runningProfiles = fresh;
      const hit = fresh.find((item) => item.profileId === profile.id);
      if (hit?.cdpWebSocketDebuggerUrl) {
        this.dismissedProfiles.delete(profile.id);
        return this.bridge.attachRunningProfile(sessionId, profile.id, name, hit.cdpWebSocketDebuggerUrl);
      }
      // Started from the launcher window: no debugging port, so restart it
      // through the API (which always injects the CDP flags) before attaching.
      await this.api.stopProfile(profile.id).catch(() => null);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    }
    this.dismissedProfiles.delete(profile.id);
    return this.bridge.startSessionProfile(sessionId, profile.id, name);
  }

  private updateStats(): void {
    if (!this.consoleStats) return;
    clear(this.consoleStats);
    const running = this.profiles.filter((profile) => isRunning(profile)).length;
    const bound = this.router.bindings().length;
    this.consoleStats.append(
      el('span', { class: 'stat' }, el('strong', { text: String(this.profiles.length) }), el('span', { text: ' 环境' })),
      el('span', { class: 'stat ok' }, el('strong', { text: String(running) }), el('span', { text: ' 运行中' })),
      el('span', { class: 'stat info' }, el('strong', { text: String(bound) }), el('span', { text: ' 已绑定' })),
    );
  }

  private applySavedOrder(profiles: Profile[]): Profile[] {
    const folderOf = profileFolder;
    const groups = new Map<string, Profile[]>();
    for (const profile of profiles) {
      const key = folderOf(profile);
      const list = groups.get(key) ?? [];
      list.push(profile);
      groups.set(key, list);
    }
    const ordered: Profile[] = [];
    for (const [folder, list] of groups) {
      const saved = this.profileOrder[folder];
      if (!saved || saved.length === 0) {
        ordered.push(...list);
        continue;
      }
      const byId = new Map(list.map((profile) => [profile.id, profile]));
      const used = new Set<string>();
      for (const id of saved) {
        const profile = byId.get(id);
        if (profile && !used.has(id)) {
          ordered.push(profile);
          used.add(id);
        }
      }
      for (const profile of list) if (!used.has(profile.id)) ordered.push(profile);
    }
    return ordered;
  }

  private statusRank(profile: Profile): number {
    if (this.router.owner(profile.id)) return 2;
    return isRunning(profile) ? 1 : 0;
  }

  private sortValue(profile: Profile, key: SortKey): string | number {
    switch (key) {
      case 'name':
        return (profile.name || profile.id).toLowerCase();
      case 'platform':
        return profileOs(profile).toLowerCase();
      case 'status':
        return this.statusRank(profile);
      case 'proxy':
        return proxyText(this.findProxy(profile)).toLowerCase();
      case 'folder':
        return profileFolder(profile).toLowerCase();
      case 'recent':
        return num((profile as any).last_launched_at) ?? 0;
      case 'created':
        return num((profile as any).created_at) ?? 0;
      case 'id':
        return profile.id.toLowerCase();
      default:
        return 0;
    }
  }

  private sortProfiles(list: Profile[]): Profile[] {
    if (this.sortKey === 'manual') return list;
    const key = this.sortKey;
    const dir = this.sortDir;
    return [...list].sort((a, b) => {
      const av = this.sortValue(a, key);
      const bv = this.sortValue(b, key);
      let cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true, sensitivity: 'base' });
      if (cmp === 0) {
        cmp = (a.name || a.id).localeCompare(b.name || b.id, 'zh-CN', { numeric: true, sensitivity: 'base' });
      }
      return cmp * dir;
    });
  }

  private saveSort(): void {
    try {
      window.localStorage.setItem('shardx-sort', JSON.stringify({ key: this.sortKey, dir: this.sortDir }));
    } catch {
      /* storage can be unavailable; the in-memory choice still applies */
    }
  }

  private setSort(key: SortKey, dir: 1 | -1): void {
    this.sortKey = key;
    this.sortDir = dir;
    this.saveSort();
    if (this.sortSelect) this.sortSelect.value = key;
    if (this.sortDirBtn) {
      this.sortDirBtn.disabled = key === 'manual';
      this.sortDirBtn.textContent = dir === 1 ? '升序 ↑' : '降序 ↓';
    }
    this.renderProfiles();
  }

  private cycleSort(key: SortKey): void {
    if (key === 'manual') {
      if (this.sortKey !== 'manual') this.setSort('manual', 1);
      return;
    }
    if (this.sortKey === key) {
      this.setSort(key, this.sortDir === 1 ? -1 : 1);
      return;
    }
    this.setSort(key, key === 'recent' || key === 'created' ? -1 : 1);
  }

  private sortHeader(label: string, key: SortKey): HTMLElement {
    const active = this.sortKey === key && key !== 'manual';
    const cell = el(
      'span',
      {
        class: `psort${active ? ' on' : ''}`,
        attrs: { role: 'button', tabindex: '0', title: `${label}：单击排序，双击切换升降序` },
      },
      el('span', { text: label }),
      el('span', { class: `sort-arrow${active ? '' : ' muted'}`, text: active ? (this.sortDir === 1 ? '↑' : '↓') : '↕' }),
    );
    let timer: number | null = null;
    cell.addEventListener('click', () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        this.cycleSort(key);
      }, 240);
    });
    cell.addEventListener('dblclick', () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      this.cycleSort(key);
    });
    cell.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.cycleSort(key);
    });
    return cell;
  }

  private renderProfiles(): void {
    if (!this.consoleGrid) return;
    this.updateStats();
    clear(this.consoleGrid);

    const query = (this.searchInput?.value ?? '').trim().toLowerCase();
    const platform = this.platformFilter?.value ?? 'all';

    const filtered = this.sortProfiles(this.applySavedOrder(this.profiles)).filter((profile) => {
      const haystack = `${profile.name ?? ''} ${profile.id} ${(profile as any).folder ?? ''}`.toLowerCase();
      if (query && !haystack.includes(query)) return false;
      if (platform === 'all') return true;
      const os = profileOs(profile).toLowerCase();
      if (platform === 'win') return os.includes('win');
      if (platform === 'mac') return os.includes('mac') || os.includes('darwin');
      if (platform === 'linux') return os.includes('linux');
      return true;
    });

    if (filtered.length === 0) {
      this.consoleGrid.appendChild(
        el(
          'div',
          { class: 'empty' },
          el('div', { class: 'big-icon' }, icon('box', 30)),
          el('strong', { text: this.profiles.length === 0 ? '还没有指纹环境' : '没有匹配的环境' }),
          el('span', {
            text:
              this.profiles.length === 0
                ? '先在 ShardX 客户端创建 profile，或点击右上角「快速新建并启动实例」。'
                : '调整搜索或平台筛选后重试。',
          }),
        ),
      );
      return;
    }

    if (this.viewMode === 'cards') {
      for (const profile of filtered) this.consoleGrid.appendChild(this.buildProfileCard(profile));
      return;
    }
    if (this.viewMode === 'list') {
      this.buildProfileListWithTabs(filtered);
      return;
    }
    this.buildProfileGroups(filtered);
  }

  private buildProfileTable(profiles: Profile[], showFolder = true, dragFolder: string | null | undefined = undefined): HTMLElement {
    const table = el('div', { class: 'ptable' });
    const head = el('div', { class: 'prow phead-row' });
    const columns: Array<[string, SortKey]> = [
      ['#', 'manual'],
      ['环境', 'name'],
      ['平台', 'platform'],
      ['状态', 'status'],
      ['代理', 'proxy'],
    ];
    for (const [label, key] of columns) head.appendChild(this.sortHeader(label, key));
    head.appendChild(el('span', { class: 'pcell-act', text: '操作' }));
    table.appendChild(head);
    profiles.forEach((profile, index) => table.appendChild(this.buildProfileRow(profile, showFolder, index, dragFolder)));
    return table;
  }

  /**
   * Folder tabs inside the local list. The tab bar is the grouping control:
   * each folder is a tab, clicking it swaps the table below to that folder's
   * profiles, and "全部环境" keeps the flat list. No separate mode is needed to
   * see or change grouping.
   */
  private buildProfileListWithTabs(profiles: Profile[]): void {
    const ALL = '__all__';
    const groups = new Map<string, Profile[]>();
    for (const profile of profiles) {
      const key = profileFolder(profile);
      const list = groups.get(key) ?? [];
      list.push(profile);
      groups.set(key, list);
    }
    const ordered = [...groups.entries()].sort((a, b) => {
      if (a[0] === '未分类') return 1;
      if (b[0] === '未分类') return -1;
      return a[0].localeCompare(b[0], 'zh');
    });
    if (ordered.length === 0) return;
    this.folderProfiles = groups;

    const keys = ordered.map(([name]) => name);
    if (this.listFolder !== ALL && (!this.listFolder || !keys.includes(this.listFolder))) this.listFolder = ALL;
    const activeKey = this.listFolder ?? ALL;
    const activeList = activeKey === ALL ? profiles : groups.get(activeKey) ?? [];

    const select = (key: string): void => {
      if (this.listFolder === key) return;
      this.listFolder = key;
      try {
        window.localStorage.setItem('shardx-list-folder', key);
      } catch {
        /* storage can be unavailable; the in-memory choice still applies */
      }
      this.renderProfiles();
    };

    const tabBar = el('div', { class: 'folder-tabs', attrs: { role: 'tablist' } });
    const addTab = (key: string, label: string, list: Profile[], glyph: string): void => {
      const active = key === activeKey;
      const running = list.filter((profile) => isRunning(profile) || this.router.owner(profile.id)).length;
      tabBar.appendChild(
        el(
          'button',
          {
            class: `folder-tab${active ? ' on' : ''}`,
            attrs: { type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false' },
            title: `${label} · ${list.length} 个环境${running > 0 ? ` · ${running} 运行中` : ''}`,
            on: { click: () => select(key) },
          },
          el('span', { class: 'folder-tab-icon', text: glyph }),
          el('span', { class: 'folder-tab-name', text: label }),
          el('span', { class: 'folder-tab-count', text: String(list.length) }),
          running > 0 ? el('span', { class: 'folder-tab-live', text: String(running) }) : null,
        ),
      );
    };
    addTab(ALL, '全部环境', profiles, '▦');
    for (const [folder, list] of ordered) addTab(folder, folder, list, '▤');

    const panel = el('section', { class: 'folder-panel list-panel' });
    panel.appendChild(
      el(
        'div',
        { class: 'folder-panel-head' },
        el(
          'div',
          { class: 'folder-panel-title' },
          el('span', { class: 'folder-panel-icon', text: '📁' }),
          el('span', { class: 'folder-panel-name', text: activeKey === ALL ? '全部环境' : activeKey }),
          el('span', { class: 'folder-panel-count', text: `${activeList.length} 个环境` }),
        ),
        el('span', {
          class: 'small muted',
          text:
            this.sortKey === 'manual'
              ? activeKey === ALL
                ? '切到文件夹标签后可拖拽排序'
                : '手动排序：拖拽行调整顺序'
              : '点表头排序',
        }),
      ),
    );
    panel.appendChild(this.buildProfileTable(activeList, activeKey === ALL, activeKey === ALL ? null : activeKey));

    const shell = el('div', { class: 'folder-shell list-shell' });
    shell.append(tabBar, panel);
    this.consoleGrid.appendChild(shell);
  }

  private buildProfileGroups(profiles: Profile[]): void {
    const groups = new Map<string, Profile[]>();
    for (const profile of profiles) {
      const key = String((profile as any).folder ?? '').trim() || '未分类';
      const list = groups.get(key) ?? [];
      list.push(profile);
      groups.set(key, list);
    }
    const ordered = [...groups.entries()].sort((a, b) => {
      if (a[0] === '未分类') return 1;
      if (b[0] === '未分类') return -1;
      return a[0].localeCompare(b[0], 'zh');
    });
    if (ordered.length === 0) return;
    this.folderProfiles = groups;

    if (!this.activeFolder || !groups.has(this.activeFolder)) {
      this.activeFolder = ordered[0][0];
    }
    const activeList = this.sortProfiles(groups.get(this.activeFolder) ?? []);
    const activeRunning = activeList.filter((profile) => isRunning(profile) || this.router.owner(profile.id)).length;

    const shell = el('div', { class: 'folder-shell' });
    const tabBar = el('div', { class: 'folder-tabs', attrs: { role: 'tablist' } });
    for (const [folder, list] of ordered) {
      const running = list.filter((profile) => isRunning(profile) || this.router.owner(profile.id)).length;
      const active = folder === this.activeFolder;
      tabBar.appendChild(
        el(
          'button',
          {
            class: `folder-tab${active ? ' on' : ''}`,
            attrs: { type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false' },
            title: `${folder} · ${list.length} 个环境${running > 0 ? ` · ${running} 运行中` : ''}`,
            on: {
              click: () => {
                if (this.activeFolder === folder) return;
                this.activeFolder = folder;
                this.renderProfiles();
              },
            },
          },
          el('span', { class: 'folder-tab-icon', text: '▤' }),
          el('span', { class: 'folder-tab-name', text: folder }),
          el('span', { class: 'folder-tab-count', text: String(list.length) }),
          running > 0 ? el('span', { class: 'folder-tab-live', text: String(running) }) : null,
        ),
      );
    }

    const viewToggle = el('div', { class: 'folder-view-toggle' });
    const views: Array<['cards' | 'list', string]> = [
      ['cards', '卡片'],
      ['list', '列表'],
    ];
    for (const [mode, label] of views) {
      viewToggle.appendChild(
        el('button', {
          class: `folder-view-btn${this.folderView === mode ? ' on' : ''}`,
          attrs: { type: 'button', 'aria-pressed': this.folderView === mode ? 'true' : 'false' },
          text: label,
          on: { click: () => this.setFolderView(mode) },
        }),
      );
    }

    const panel = el('section', { class: 'folder-panel' });
    panel.appendChild(
      el(
        'div',
        { class: 'folder-panel-head' },
        el(
          'div',
          { class: 'folder-panel-title' },
          el('span', { class: 'folder-panel-icon', text: '📁' }),
          el('span', { class: 'folder-panel-name', text: this.activeFolder }),
          el('span', { class: 'folder-panel-count', text: `${activeList.length} 个环境` }),
          activeRunning > 0 ? el('span', { class: 'folder-panel-live', text: `${activeRunning} 运行中` }) : null,
        ),
        viewToggle,
      ),
    );

    if (this.folderView === 'list') {
      panel.appendChild(this.buildProfileTable(activeList, false, this.activeFolder));
    } else {
      const cards = el('div', { class: 'folder-cards' });
      for (const profile of activeList) cards.appendChild(this.buildProfileCard(profile, this.sortKey === 'manual' ? this.activeFolder : null));
      panel.appendChild(cards);
    }

    shell.append(tabBar, panel);
    this.consoleGrid.appendChild(shell);
  }

  private setFolderView(mode: 'cards' | 'list'): void {
    if (this.folderView === mode) return;
    this.folderView = mode;
    try {
      window.localStorage.setItem('shardx-folder-view', mode);
    } catch {
      /* storage may be unavailable; the in-memory choice still applies */
    }
    this.renderProfiles();
  }

  private buildProfileRow(
    profile: Profile,
    showFolder = true,
    index = 0,
    dragFolder: string | null | undefined = undefined,
  ): HTMLElement {
    const proxy = this.findProxy(profile);
    const protocol = proxyProtocol(proxy);
    const owner = this.router.owner(profile.id);
    const folder = dragFolder === undefined ? profileFolder(profile) : dragFolder;
    const dragTarget = this.sortKey === 'manual' ? folder : null;
    const row = el('div', { class: `prow${owner ? ' bound' : ''}` });

    const indexCell = el(
      'div',
      { class: 'pcell pindex' },
      dragTarget ? el('span', { class: 'grip', text: '⋮⋮', title: '拖拽调整顺序' }) : null,
      el('span', { class: 'pindex-num', text: String(index + 1).padStart(2, '0') }),
    );

    const nameCell = el(
      'div',
      { class: 'pcell name-cell' },
      el('span', { class: 'pname', text: profile.name || profile.id, title: profile.id }),
      el(
        'span',
        { class: 'psub' },
        el('span', { text: `ID ${shortId(profile.id)}` }),
        showFolder && (profile as any).folder ? el('span', { text: ` · 📁 ${(profile as any).folder}` }) : el('span'),
      ),
    );

    const statusCell = el(
      'div',
      { class: 'pcell' },
      owner
        ? badge(`🔒 ${sessionTag(owner)}`, 'warning')
        : isRunning(profile)
          ? badge('运行中', 'success')
          : badge('已停止', 'neutral'),
    );

    const proxyCell = el(
      'div',
      { class: 'pcell proxy-cell' },
      el('span', { class: `dot ${protocol === 'udp' ? 'udp' : protocol === 'tcp' ? 'ok' : 'muted'}` }),
      el('span', { text: proxyText(proxy), title: proxyText(proxy) }),
    );

    const startBtn = button(owner === this.sessionId ? '打开' : owner ? '接管' : '启动', {
      class: `btn small${owner === this.sessionId ? ' primary' : ''}`,
      icon: owner === this.sessionId ? 'external' : 'play',
      title: owner
        ? `该实例当前由会话 ${sessionTag(owner)} 使用，点击接管到当前会话`
        : '绑定到当前会话并启动',
    }) as HTMLButtonElement;
    startBtn.addEventListener('click', () => void this.startProfileInSession(profile, this.sessionId, startBtn));

    const actions = el('div', { class: 'pcell pcell-act' }, startBtn);
    actions.append(
      iconButton('stop', {
        title:
          owner === this.sessionId
            ? '停止实例并释放独占锁'
            : owner
              ? `无法停止：会话 ${sessionTag(owner)} 正在独占`
              : isRunning(profile)
                ? '停止实例'
                : '实例未运行',
        class: 'danger-icon',
        onClick: () => void this.stopProfile(profile),
      }),
      iconButton('restart', {
        title: owner && owner !== this.sessionId ? `无法重启：会话 ${sessionTag(owner)} 正在独占` : '重启实例',
        onClick: () => void this.restartProfile(profile),
      }),
      iconButton('settings', {
        title: '编辑名称 / 分组 / 备注',
        onClick: () => this.openProfileEditor(profile),
      }),
      iconButton('chart', {
        title: '查看环境详情',
        onClick: () => this.showProfileDetails(profile),
      }),
      iconButton('trash', {
        title: owner && owner !== this.sessionId ? `无法删除：会话 ${sessionTag(owner)} 正在独占` : '删除环境',
        class: 'danger-icon',
        onClick: () => this.confirmDeleteProfile(profile),
      }),
    );

    row.append(
      indexCell,
      nameCell,
      el('div', { class: 'pcell' }, badge(profileOs(profile), 'info')),
      statusCell,
      proxyCell,
      actions,
    );
    this.attachProfileDrag(row, profile, dragTarget);
    return row;
  }

  private findProxy(profile: Profile): Proxy | null {
    const id = str((profile as any).proxy_id);
    if (!id) return null;
    return this.proxies.find((proxy) => str((proxy as any).id) === id) ?? null;
  }

  private buildProfileCard(profile: Profile, dragFolder: string | null = null): HTMLElement {
    const proxy = this.findProxy(profile);
    const protocol = proxyProtocol(proxy);
    const boundOwner = this.router.owner(profile.id);

    const card = el('div', { class: 'profile-card' });

    const head = el('div', { class: 'head' });
    head.append(
      el('span', { class: 'name', text: profile.name || profile.id, title: profile.id }),
      isRunning(profile) ? badge('运行中', 'success', true) : badge('已停止', 'neutral', true),
      badge(profileOs(profile), 'info'),
    );
    if (boundOwner) {
      head.appendChild(badge(`🔒 ${sessionTag(boundOwner)}`, 'warning'));
    }
    card.appendChild(head);

    const meta = el('div', { class: 'meta' });
    meta.append(
      el('span', { class: 'small', text: `ID ${shortId(profile.id)}` }),
      (profile as any).folder ? el('span', { class: 'small', text: `📁 ${(profile as any).folder}` }) : el('span'),
      el(
        'span',
        { class: `badge ${protocol === 'udp' ? 'info' : protocol === 'tcp' ? 'success' : 'neutral'}` },
        el('span', { class: `dot ${protocol === 'udp' ? 'udp' : protocol === 'tcp' ? 'ok' : 'muted'}` }),
        el('span', { text: proxyLabel(proxy) }),
      ),
    );
    card.appendChild(meta);

    const kv = el('div', { class: 'kv' });
    const add = (key: string, value: string, title?: string) => {
      kv.append(
        el('span', { class: 'k', text: key }),
        el('span', { class: 'v', text: value || '—', title: title ?? value }),
      );
    };
    const addIf = (key: string, value: string) => {
      const text = value.trim();
      if (!text || text === '—') return;
      add(key, text);
    };
    add('代理', proxyText(proxy), proxyText(proxy));
    addIf('地区', str((proxy as any)?.country ?? (proxy as any)?.region ?? ''));
    addIf('内核', profileKernel(profile));
    const hardware = [profileCpu(profile), profileMemory(profile)]
      .map((part) => part.trim())
      .filter((part) => part && part !== '—')
      .join(' · ');
    addIf('硬件', hardware);
    addIf('时区', profileTimezone(profile));
    addIf('噪音种子', profileNoise(profile));
    card.appendChild(kv);

    const actions = el('div', { class: 'actions card-actions' });
    const knownSessions = new Set<string>([this.sessionId, ...this.router.sessionIds()]);
    if (boundOwner) knownSessions.add(boundOwner);

    let select: HTMLSelectElement | null = null;
    if (knownSessions.size > 1) {
      select = el('select', { class: 'select session-select', attrs: { title: '选择要绑定到的会话' } }) as HTMLSelectElement;
      for (const session of knownSessions) {
        const suffix = session === this.sessionId ? '（当前）' : '';
        select.appendChild(
          el('option', { text: `${sessionTag(session)}${suffix}`, attrs: { value: session } }),
        );
      }
      select.value = boundOwner ?? this.sessionId;
      select.disabled = Boolean(boundOwner && boundOwner !== this.sessionId);
      actions.appendChild(select);
    }

    const startBtn = button(
      boundOwner === this.sessionId ? '打开实例' : '启动实例',
      {
        class: `btn${boundOwner === this.sessionId ? ' primary' : ''}`,
        icon: boundOwner === this.sessionId ? 'external' : 'play',
        disabled: Boolean(boundOwner),
        title: boundOwner
          ? `该 profile 已被会话 ${boundOwner} 独占`
          : `绑定到会话 ${sessionTag(select?.value ?? this.sessionId)} 后启动指纹浏览器并打开实例视图`,
        onClick: () => void this.startProfileInSession(profile, select?.value ?? this.sessionId, startBtn),
      },
    );

    actions.appendChild(startBtn);

    const tools = el('div', { class: 'card-tools' });
    tools.append(
      iconButton('stop', {
        title:
          boundOwner === this.sessionId
            ? '停止实例并释放独占锁'
            : boundOwner
              ? `无法停止：会话 ${sessionTag(boundOwner)} 正在独占`
              : isRunning(profile)
                ? '停止实例'
                : '实例未运行',
        class: 'danger-icon',
        onClick: () => void this.stopProfile(profile),
      }),
      iconButton('restart', {
        title: boundOwner && boundOwner !== this.sessionId ? `无法重启：会话 ${sessionTag(boundOwner)} 正在独占` : '重启实例',
        onClick: () => void this.restartProfile(profile),
      }),
      iconButton('settings', {
        title: '编辑名称 / 分组 / 备注',
        onClick: () => this.openProfileEditor(profile),
      }),
      iconButton('chart', {
        title: '查看环境详情',
        onClick: () => this.showProfileDetails(profile),
      }),
      iconButton('trash', {
        title: boundOwner && boundOwner !== this.sessionId ? `无法删除：会话 ${sessionTag(boundOwner)} 正在独占` : '删除环境',
        class: 'danger-icon',
        onClick: () => this.confirmDeleteProfile(profile),
      }),
    );
    actions.appendChild(tools);

    card.appendChild(actions);
    this.attachProfileDrag(card, profile, dragFolder);
    return card;
  }

  private attachProfileDrag(item: HTMLElement, profile: Profile, folder: string | null): void {
    item.draggable = Boolean(folder);
    if (!folder) return;
    const isCard = item.classList.contains('profile-card');
    if (!isCard) item.classList.add('has-drag-grip');
    item.addEventListener('dragstart', (event) => {
      this.dragProfileId = profile.id;
      item.classList.add('dragging');
      item.closest('.ptable')?.classList.add('dragging-active');
      item.closest('.folder-cards')?.classList.add('dragging-active');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', profile.id);
      }
    });
    item.addEventListener('dragend', () => {
      this.dragProfileId = null;
      item.classList.remove('dragging');
      item.closest('.ptable')?.classList.remove('dragging-active');
      item.closest('.folder-cards')?.classList.remove('dragging-active');
    });
    if (isCard) return;
    item.addEventListener('dragover', (event) => {
      const source = this.dragProfileId;
      if (!source || source === profile.id) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      item.classList.add('drop-target');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      item.classList.remove('drop-target');
      const source = this.dragProfileId;
      this.dragProfileId = null;
      if (source) this.reorderProfile(folder, source, profile.id);
    });
  }

  private reorderProfile(folder: string, sourceId: string, targetId: string): void {
    const list = this.folderProfiles.get(folder);
    if (!list) return;
    const ids = list.map((profile) => profile.id);
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    this.saveProfileOrder(folder, ids);
    this.renderProfiles();
  }

  private saveProfileOrder(folder: string, ids: string[]): void {
    try {
      const raw = window.localStorage.getItem('shardx-profile-order');
      const all = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
      all[folder] = ids;
      window.localStorage.setItem('shardx-profile-order', JSON.stringify(all));
    } catch {
      /* storage may be unavailable; the in-memory refresh already shows the new order */
    }
  }

  private async stopProfile(profile: Profile): Promise<void> {
    const owner = this.router.owner(profile.id);
    if (owner) {
      if (owner === this.sessionId) {
        await this.releaseProfile(profile);
        return;
      }
      toast(`无法停止：「${profile.name || profile.id}」由会话 ${sessionTag(owner)} 独占`, 'error', 5000);
      return;
    }
    if (!isRunning(profile)) {
      toast(`「${profile.name || profile.id}」当前未运行`, 'info', 2200);
      return;
    }
    try {
      await this.api.stopProfile(profile.id);
      toast(`已停止「${profile.name || profile.id}」`, 'success');
      void this.refreshAll(true);
    } catch (error) {
      toast(`停止失败：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
    }
  }

  private async restartProfile(profile: Profile): Promise<void> {
    const owner = this.router.owner(profile.id);
    if (owner && owner !== this.sessionId) {
      toast(`无法重启：「${profile.name || profile.id}」由会话 ${sessionTag(owner)} 独占`, 'error', 5000);
      return;
    }
    if (owner === this.sessionId) {
      await this.releaseProfile(profile);
      await this.startProfileInSession(profile, this.sessionId);
      return;
    }
    if (isRunning(profile)) {
      try {
        await this.api.stopProfile(profile.id);
      } catch (error) {
        toast(`重启失败：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
        return;
      }
    }
    await this.startProfileInSession(profile, this.sessionId);
  }

  private openProfileEditor(profile: Profile): void {
    const nameInput = el('input', {
      class: 'input',
      attrs: { type: 'text', value: profile.name || '', placeholder: '环境名称' },
    }) as HTMLInputElement;
    const folderInput = el('input', {
      class: 'input',
      attrs: { type: 'text', value: String((profile as any).folder ?? ''), placeholder: '如 Google、新账号' },
    }) as HTMLInputElement;
    const notesInput = el('textarea', {
      class: 'input',
      attrs: { rows: '3', placeholder: '备注（可选）' },
    }) as HTMLTextAreaElement;
    notesInput.value = String((profile as any).notes ?? '');

    const folders = [...this.folderProfiles.keys()].filter((name) => name !== '未分类');
    const chips = el('div', { class: 'folder-chips' });
    for (const name of folders) {
      chips.appendChild(
        el('button', {
          class: 'chip',
          attrs: { type: 'button' },
          text: name,
          on: { click: () => { folderInput.value = name; } },
        }),
      );
    }

    const form = el(
      'div',
      { class: 'form' },
      el('label', { class: 'field' }, el('span', { text: '名称' }), nameInput),
      el('label', { class: 'field' }, el('span', { text: '分组' }), folderInput, folders.length > 0 ? chips : null),
      el('label', { class: 'field' }, el('span', { text: '备注' }), notesInput),
      el('p', { class: 'small', text: '修改会写回 ShardX profile，并同步到分组与列表。' }),
    );

    const cancel = button('取消', { class: 'btn', onClick: () => overlay.remove() });
    const save = button('保存修改', {
      class: 'btn primary',
      icon: 'check',
      onClick: () => {
        const name = nameInput.value.trim();
        if (!name) {
          toast('名称不能为空', 'error');
          nameInput.focus();
          return;
        }
        save.disabled = true;
        void this.api
          .updateProfile(profile.id, { name, folder: folderInput.value.trim(), notes: notesInput.value.trim() })
          .then(() => {
            overlay.remove();
            toast('已保存环境信息', 'success');
            void this.refreshAll(true);
          })
          .catch((error) => {
            save.disabled = false;
            toast(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error', 7000);
          });
      },
    });

    const overlay = this.openModal(`编辑环境 · ${profile.name || profile.id}`, form, [cancel, save]);
    window.setTimeout(() => nameInput.focus(), 0);
  }

  private showProfileDetails(profile: Profile): void {
    const proxy = this.findProxy(profile);
    const owner = this.router.owner(profile.id);
    const rows: Array<[string, string]> = [
      ['环境 ID', profile.id],
      ['名称', profile.name || '—'],
      ['分组', String((profile as any).folder ?? '') || '未分类'],
      ['平台', profileOs(profile)],
      ['状态', owner ? `会话 ${sessionTag(owner)} 独占` : isRunning(profile) ? '运行中' : '已停止'],
      ['代理', proxyText(proxy)],
      ['内核', profileKernel(profile)],
      ['CPU', profileCpu(profile)],
      ['内存', profileMemory(profile)],
      ['时区', profileTimezone(profile)],
      ['噪音种子', profileNoise(profile)],
      ['备注', String((profile as any).notes ?? '') || '—'],
    ];
    const list = el('div', { class: 'detail-list' });
    for (const [key, value] of rows) {
      list.append(el('span', { class: 'k', text: key }), el('span', { class: 'v', text: value }));
    }
    const copy = button('复制 ID', {
      class: 'btn small',
      icon: 'copy',
      onClick: () => {
        void navigator.clipboard
          .writeText(profile.id)
          .then(() => toast('已复制环境 ID', 'success'))
          .catch(() => toast('复制失败：剪贴板不可用', 'error'));
      },
    });
    const close = button('关闭', { class: 'btn', onClick: () => overlay.remove() });
    const overlay = this.openModal(`环境详情 · ${profile.name || profile.id}`, list, [copy, close]);
  }

  private confirmDeleteProfile(profile: Profile): void {
    const owner = this.router.owner(profile.id);
    const body = el(
      'div',
      { class: 'form' },
      el('p', {
        class: 'small',
        text: `确定要删除「${profile.name || profile.id}」吗？该操作会移除 ShardX 指纹环境及其本地数据，无法撤销。`,
      }),
      owner ? el('p', { class: 'small err', text: `当前由会话 ${sessionTag(owner)} 使用，删除会先停止实例。` }) : null,
    );
    const cancel = button('取消', { class: 'btn', onClick: () => overlay.remove() });
    const del = button('删除', {
      class: 'btn danger',
      icon: 'trash',
      onClick: () => {
        del.disabled = true;
        void this.deleteProfile(profile, overlay).catch(() => {
          del.disabled = false;
        });
      },
    });
    const overlay = this.openModal(`删除环境 · ${profile.name || profile.id}`, body, [cancel, del]);
  }

  private async deleteProfile(profile: Profile, overlay?: HTMLElement | null): Promise<void> {
    const owner = this.router.owner(profile.id);
    if (owner && owner !== this.sessionId) {
      toast(`无法删除：「${profile.name || profile.id}」由会话 ${sessionTag(owner)} 独占`, 'error', 6000);
      return;
    }
    try {
      if (owner === this.sessionId) await this.releaseProfile(profile);
      else if (isRunning(profile)) await this.api.stopProfile(profile.id);
      await this.api.deleteProfile(profile.id);
      this.closeTab(`instance:${profile.id}`, true);
      overlay?.remove();
      toast(`已删除「${profile.name || profile.id}」`, 'success');
      void this.refreshAll(true);
    } catch (error) {
      toast(`删除失败：${error instanceof Error ? error.message : String(error)}`, 'error', 8000);
      throw error;
    }
  }

  private async startProfileInSession(profile: Profile, sessionId: string, trigger?: HTMLButtonElement): Promise<void> {
    const existing = this.tabs.get(`instance:${profile.id}`);
    if (existing) {
      const sandbox = this.router.getByProfile(profile.id);
      if (sandbox && sandbox.sessionId !== sessionId) {
        this.router.reassign(profile.id, sessionId);
        void this.saveInstanceMapping(sandbox);
        this.renderTabBar();
      }
      this.activateTab(existing.id);
      return;
    }
    let original = '启动';
    if (trigger) {
      trigger.disabled = true;
      const labelNode = trigger.querySelector('span:last-child');
      original = labelNode?.textContent ?? trigger.textContent ?? original;
      if (labelNode) labelNode.textContent = '启动中…';
    }
    try {
      const sandbox = await this.attachOrStart(profile, sessionId);
      this.router.patch(profile.id, { targets: [] });
      this.openInstanceTab(sandbox, profile);
      toast(`已在会话 ${sessionTag(sessionId)} 启动「${profile.name || profile.id}」`, 'success');
      void this.refreshAll(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(`启动失败：${message}`, 'error', 7000);
      console.error('[ShardX] 启动失败', error);
    } finally {
      if (trigger) {
        trigger.disabled = false;
        const label = trigger.querySelector('span:last-child');
        if (label) label.textContent = original;
      }
    }
  }

  private async releaseProfile(profile: Profile): Promise<void> {
    const sandbox = this.router.getByProfile(profile.id);
    if (!sandbox) return;
    try {
      await this.bridge.releaseProfile(profile.id);
      await this.workspace.removeMapping(profile.id).catch(() => null);
      toast(`已释放「${profile.name || profile.id}」`, 'success');
      this.closeTab(`instance:${profile.id}`, true);
      void this.refreshAll(true);
      void this.refreshWorkspace(true);
    } catch (error) {
      toast(`释放失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private onRouterChange(): void {
    this.updateStats();
    for (const [id, controller] of this.controllers) {
      const sandbox = this.router.getByProfile(controller.sandbox.profileId);
      if (!sandbox) {
        this.closeTab(id, true);
        continue;
      }
      controller.sandbox = sandbox;
      if (sandbox.status === 'error') {
        this.appendLog(controller, `会话状态异常：${sandbox.lastError ?? '未知错误'}`, 'error');
      }
    }
    this.renderTabBar();
  }

  // ------------------------------------------------------------------
  // Instance view
  // ------------------------------------------------------------------
  private buildInstanceView(sandbox: SessionSandbox, profile: Profile | null): InstanceController {
    const view = el('div', { class: 'instance-view' });

    const back = iconButton('chevron', { title: '后退', class: 'chrome-btn', onClick: () => void this.history(-1) });
    back.style.transform = 'rotate(90deg)';
    const forward = iconButton('chevron', { title: '前进', class: 'chrome-btn', onClick: () => void this.history(1) });
    forward.style.transform = 'rotate(-90deg)';
    const reload = iconButton('refresh', { title: '刷新页面', class: 'chrome-btn', onClick: () => void this.reload() });

    const urlInput = el('input', {
      class: 'input url',
      attrs: { type: 'text', spellcheck: 'false', placeholder: '输入网址，例如 https://example.com' },
    }) as HTMLInputElement;
    urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.navigate(urlInput.value);
      }
    });

    const go = iconButton('arrow', { title: '打开地址', class: 'chrome-btn', onClick: () => void this.navigate(urlInput.value) });
    const shot = iconButton('box', { title: '重新截取画面', class: 'chrome-btn', onClick: () => void this.capture(true) });
    const cookies = iconButton('key', { title: 'Cookie 读取 / 注入 / 清理', class: 'chrome-btn', onClick: () => this.openCookies() });
    const detailsBtn = iconButton('chart', { title: '显示 / 隐藏实例详情', class: 'chrome-btn' });

    const lockBtn = el('button', {
      class: 'btn lock-btn',
      attrs: { type: 'button' },
      title: `当前 profile 由本会话独占：${sandbox.sessionId}（点击释放）`,
      on: { click: () => void this.releaseCurrent() },
    });
    lockBtn.append(
      icon('key', 12),
      el('span', { class: 'lock-name', text: profile?.name || sandbox.profileName || shortId(sandbox.profileId) }),
    );

    const release = button('释放', {
      class: 'btn danger small',
      icon: 'stop',
      title: '停止浏览器并释放会话独占锁',
      onClick: () => void this.releaseCurrent(),
    });

    const urlPill = el('div', { class: 'url-pill' }, icon('globe', 13), urlInput, go);
    const chrome = el(
      'div',
      { class: 'browser-chrome' },
      el('div', { class: 'nav-row' }, back, forward, reload, urlPill, shot, cookies, detailsBtn, lockBtn, release),
    );

    const pagesBar = el('div', { class: 'pages-bar' });

    const image = el('img', { attrs: { alt: 'ShardX 实例实时画面' } }) as HTMLImageElement;
    image.tabIndex = 0;
    image.style.outline = 'none';
    image.style.cursor = 'crosshair';
    const placeholder = el('div', { class: 'placeholder' }, el('div', { text: '正在连接 CDP…' }), el('div', { class: 'small', text: '首个画面会在 1~2 秒内出现' }));
    const viewport = el('div', { class: 'viewport' }, image, placeholder);

    const inspector = el('div', { class: 'inspector' });
    const drawer = el('div', { class: 'inspector-drawer' }, inspector);
    const telemetry = el('div', { class: 'telemetry' });
    const workarea = el('div', { class: 'workarea' }, viewport, drawer);

    const statusbar = el(
      'div',
      { class: 'statusbar' },
      el('span', { class: 'sb-item', text: `${profile ? proxyText(this.findProxy(profile)) : '未知代理'} · 会话 ${sessionTag(sandbox.sessionId)} 独占` }),
      el('span', { class: 'sb-item sb-right', text: 'CDP 连接中…' }),
    );

    const controller: InstanceController = {
      sandbox,
      profile,
      proxy: profile ? this.findProxy(profile) : null,
      view,
      image,
      placeholder,
      urlInput,
      titleEl: el('span'),
      pagesBar,
      inspector,
      drawer,
      telemetry,
      lockBtn,
      detailsBtn,
      statusbar,
      frameTimer: null,
      targetsTimer: null,
      busy: false,
      layout: { width: 1280, height: 800 },
      targetId: sandbox.activeTargetId,
      cdpSessionId: sandbox.activeCdpSessionId,
      lastError: null,
      logCount: 0,
    };

    detailsBtn.addEventListener('click', () => {
      const open = controller.drawer.classList.toggle('open');
      detailsBtn.classList.toggle('on', open);
    });

    view.append(chrome, pagesBar, workarea, statusbar);
    this.renderInspector(controller);


    image.addEventListener('click', (event) => void this.forwardClick(controller, event));
    image.addEventListener('keydown', (event) => {
      event.preventDefault();
      void this.forwardKey(controller, event);
    });

    controller.targetsTimer = window.setInterval(() => {
      if (this.activeTabId === `instance:${controller.sandbox.profileId}`) void this.refreshTargets(controller);
    }, 4000);
    controller.frameTimer = window.setInterval(() => {
      if (this.activeTabId === `instance:${controller.sandbox.profileId}`) void this.refreshFrame(controller);
    }, 1300);

    void this.refreshTargets(controller);
    void this.refreshFrame(controller, true);
    return controller;
  }

  private controllerFor(profileId: string): InstanceController | null {
    return this.controllers.get(`instance:${profileId}`) ?? null;
  }

  private sandboxFor(profileId: string): SessionSandbox | null {
    return this.router.getByProfile(profileId);
  }

  private renderInspector(controller: InstanceController): void {
    const { inspector } = controller;
    clear(inspector);

    const profile = controller.profile;
    const sandbox = controller.sandbox;

    const sessionSection = el('div', { class: 'section' });
    sessionSection.appendChild(el('h3', { text: '会话 / 隔离' }));
    const sessionKv = el('div', { class: 'kv' });
    const addSession = (key: string, value: string, title?: string) => {
      sessionKv.append(
        el('span', { class: 'k', text: key }),
        el('span', { class: 'v', text: value || '—', title: title ?? value }),
      );
    };
    addSession('会话', sessionTag(sandbox.sessionId), sandbox.sessionId);
    addSession('Profile', sandbox.profileId);
    addSession('状态', sandbox.status);
    addSession('CDP', sandbox.cdpWsUrl ?? '—', sandbox.cdpWsUrl ?? '');
    addSession('独占锁', this.router.owner(sandbox.profileId) === sandbox.sessionId ? '本会话持有' : '未持有');
    if (sandbox.lastError) addSession('错误', sandbox.lastError);
    sessionSection.appendChild(sessionKv);
    inspector.appendChild(sessionSection);

    const fpSection = el('div', { class: 'section' });
    fpSection.appendChild(el('h3', { text: '指纹 / 网络' }));
    const fpKv = el('div', { class: 'kv' });
    const addFp = (key: string, value: string) => {
      const text = value.trim();
      if (!text || text === '—') return;
      fpKv.append(el('span', { class: 'k', text: key }), el('span', { class: 'v', text }));
    };
    if (profile) {
      addFp('系统', profileOs(profile));
      addFp('内核', profileKernel(profile));
      const hardware = [profileCpu(profile), profileMemory(profile)].filter((value) => value && value !== '—').join(' · ');
      addFp('硬件', hardware);
      addFp('时区', profileTimezone(profile));
      addFp('噪音种子', profileNoise(profile));
      addFp('代理', proxyText(controller.proxy));
      addFp('协议', controller.proxy ? (proxyProtocol(controller.proxy) === 'udp' ? 'UDP/QUIC' : 'TCP') : '直连');
    } else {
      addFp('Profile', '未知（未加载详情）');
    }
    fpSection.appendChild(fpKv);
    inspector.appendChild(fpSection);

    const pageSection = el('div', { class: 'section' });
    pageSection.appendChild(el('h3', { text: '页面' }));
    const title = el('div', { class: 'page-title', text: '尚未导航' });
    const url = el('div', { class: 'page-url small', text: 'about:blank' });
    pageSection.append(title, url);
    controller.titleEl = title;
    inspector.appendChild(pageSection);

    const logSection = el('div', { class: 'section' });
    logSection.appendChild(el('h3', { text: 'CDP 操作日志' }));
    logSection.appendChild(controller.telemetry);
    inspector.appendChild(logSection);

    this.appendLog(controller, '实例视图已打开');
  }

  private appendLog(controller: InstanceController, text: string, tone: 'neutral' | 'error' = 'neutral'): void {
    if (controller.logCount > 220) {
      const first = controller.telemetry.firstElementChild;
      if (first) first.remove();
    }
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = el(
      'div',
      { class: `line${tone === 'error' ? ' err' : ''}` },
      el('span', { class: 't', text: stamp }),
      el('span', { text }),
    );
    controller.telemetry.appendChild(line);
    controller.telemetry.scrollTop = controller.telemetry.scrollHeight;
    controller.logCount += 1;
  }

  private setStatus(controller: InstanceController, text: string, tone: 'normal' | 'error' = 'normal'): void {
    const right = controller.statusbar.querySelector('.sb-right');
    if (!right) return;
    right.textContent = text;
    right.classList.toggle('err', tone === 'error');
  }

  private async refreshFrame(controller: InstanceController, force = false): Promise<void> {
    if (controller.busy) return;
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp?.isOpen()) {
      controller.placeholder.textContent = 'CDP 连接已断开';
      this.setStatus(controller, 'CDP 连接已断开', 'error');
      return;
    }
    controller.busy = true;
    try {
      const page = await this.bridge.resolvePage(sandbox);
      controller.cdpSessionId = page.cdpSessionId;
      controller.targetId = page.targetId;
      await this.captureScreenshot(controller, force);
      const info = await sandbox.cdp.send<{ result?: { value?: string } }>(
        'Runtime.evaluate',
        {
          expression: 'JSON.stringify({url: location.href, title: document.title, w: innerWidth, h: innerHeight, dpr: devicePixelRatio})',
          returnByValue: true,
        },
        controller.cdpSessionId,
        8000,
      );
      const raw = info.result?.value;
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw) as { url?: string; title?: string; w?: number; h?: number; dpr?: number };
          if (parsed.url && document.activeElement !== controller.urlInput) controller.urlInput.value = parsed.url;
          controller.titleEl.textContent = parsed.title || parsed.url || '未命名页面';
          const pageUrl = controller.inspector.querySelector('.page-url');
          if (pageUrl) pageUrl.textContent = parsed.url ?? '';
          if (parsed.w && parsed.h) {
            controller.layout.width = Math.round(parsed.w);
            controller.layout.height = Math.round(parsed.h);
          }
        } catch {
          /* ignore malformed page info */
        }
      }
      controller.lastError = null;
      controller.placeholder.style.display = 'none';
      this.setStatus(
        controller,
        `${controller.titleEl.textContent || '页面'} · ${controller.layout.width}×${controller.layout.height}`,
      );
      if (force) this.appendLog(controller, '已刷新画面');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(controller, message, 'error');
      if (controller.lastError !== message) {
        controller.lastError = message;
        this.appendLog(controller, `画面刷新失败：${message}`, 'error');
      }
    } finally {
      controller.busy = false;
    }
  }

  private async captureScreenshot(controller: InstanceController, force = false): Promise<void> {
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp) return;
    const shot = await sandbox.cdp.send<{ data?: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: force ? 82 : 60, captureBeyondViewport: false },
      controller.cdpSessionId,
      15000,
    );
    if (!shot.data) return;
    controller.image.src = `data:image/jpeg;base64,${shot.data}`;
    controller.image.style.display = 'block';
    controller.placeholder.style.display = 'none';
    const metrics = await sandbox.cdp
      .send<any>('Page.getLayoutMetrics', {}, controller.cdpSessionId, 8000)
      .catch(() => null);
    const vp = metrics?.cssLayoutViewport ?? metrics?.layoutViewport;
    if (vp && vp.clientWidth && vp.clientHeight) {
      controller.layout.width = vp.clientWidth;
      controller.layout.height = vp.clientHeight;
    }
  }

  private async refreshTargets(controller: InstanceController): Promise<void> {
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp?.isOpen()) return;
    try {
      const result = await sandbox.cdp.send<{ targetInfos?: TargetInfo[] }>('Target.getTargets', {}, null, 8000);
      const pages = (result.targetInfos ?? []).filter((target) => target.type === 'page');
      clear(controller.pagesBar);
      if (pages.length === 0) {
        controller.pagesBar.appendChild(el('span', { class: 'small', text: '单页模式（此 CDP 端点不暴露页面列表）' }));
        return;
      }
      for (const page of pages) {
        const active = page.targetId === controller.targetId;
        const tab = el('button', {
          class: `page-tab${active ? ' active' : ''}`,
          attrs: { type: 'button', title: page.url },
          on: { click: () => void this.switchTarget(controller, page) },
        });
        tab.append(
          el('span', { text: page.title || page.url || '新标签页' }),
          el('span', { class: 'page-tab-url', text: page.url ? new URL(page.url, 'https://x').host : '' }),
        );
        controller.pagesBar.appendChild(tab);
      }
      const nav = button('+ 新标签页', {
        class: 'btn',
        onClick: () => void this.createTab(controller),
      });
      controller.pagesBar.appendChild(nav);
    } catch (error) {
      controller.pagesBar.textContent = '';
      controller.pagesBar.appendChild(el('span', { class: 'small', text: '页面列表不可用（单页 CDP 模式）' }));
    }
  }

  private async switchTarget(controller: InstanceController, target: TargetInfo): Promise<void> {
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp) return;
    try {
      await sandbox.cdp.send('Target.activateTarget', { targetId: target.targetId }, null, 8000);
      const attached = await sandbox.cdp.send<{ sessionId?: string }>(
        'Target.attachToTarget',
        { targetId: target.targetId, flatten: true },
        null,
        8000,
      );
      this.router.patch(sandbox.profileId, {
        activeTargetId: target.targetId,
        activeCdpSessionId: attached.sessionId ?? null,
      });
      controller.targetId = target.targetId;
      controller.cdpSessionId = attached.sessionId ?? null;
      await this.refreshFrame(controller);
      this.appendLog(controller, `切换到页面 ${target.title || target.targetId}`);
    } catch (error) {
      this.appendLog(controller, `切换页面失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async createTab(controller: InstanceController): Promise<void> {
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp) return;
    try {
      await sandbox.cdp.send('Target.createTarget', { url: 'about:blank' }, null, 10000);
      await this.refreshTargets(controller);
      this.appendLog(controller, '已创建新标签页');
    } catch (error) {
      toast(`创建标签页失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async navigate(rawUrl: string): Promise<void> {
    const controller = this.activeController();
    if (!controller) return;
    const url = normalizeUrl(rawUrl);
    if (!url) {
      toast('请输入网址', 'warning');
      return;
    }
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp) {
      toast('CDP 未连接', 'error');
      return;
    }
    try {
      controller.urlInput.value = url;
      const result = await sandbox.cdp.send<{ errorText?: string }>(
        'Page.navigate',
        { url },
        controller.cdpSessionId,
        20000,
      );
      if (result.errorText) throw new Error(result.errorText);
      this.setStatus(controller, `正在打开 ${url}…`);
      this.appendLog(controller, `导航 → ${url}`);
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      await this.refreshFrame(controller);
      await this.refreshTargets(controller);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendLog(controller, `导航失败：${message}`, 'error');
      toast(`导航失败：${message}`, 'error', 6000);
    }
  }

  private activeController(): InstanceController | null {
    return this.controllers.get(this.activeTabId) ?? null;
  }

  private async history(delta: number): Promise<void> {
    const controller = this.activeController();
    if (!controller) return;
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp) return;
    try {
      const history = await sandbox.cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
        'Page.getNavigationHistory',
        {},
        controller.cdpSessionId,
      );
      const entry = history.entries[history.currentIndex + delta];
      if (!entry) return;
      await sandbox.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, controller.cdpSessionId);
      this.appendLog(controller, delta < 0 ? '后退' : '前进');
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      await this.refreshFrame(controller);
    } catch (error) {
      this.appendLog(controller, `历史导航失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async reload(): Promise<void> {
    const controller = this.activeController();
    if (!controller) return;
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp) return;
    try {
      await sandbox.cdp.send('Page.reload', { ignoreCache: true }, controller.cdpSessionId);
      this.appendLog(controller, '刷新页面');
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      await this.refreshFrame(controller);
    } catch (error) {
      this.appendLog(controller, `刷新失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async capture(manual: boolean): Promise<void> {
    const controller = this.activeController();
    if (!controller) return;
    await this.refreshFrame(controller, manual);
    if (manual) toast('画面已更新', 'success', 1500);
  }

  private async forwardClick(controller: InstanceController, event: MouseEvent): Promise<void> {
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp) return;
    const rect = controller.image.getBoundingClientRect();
    const naturalWidth = controller.image.naturalWidth || controller.layout.width;
    const naturalHeight = controller.image.naturalHeight || controller.layout.height;
    if (!naturalWidth || !naturalHeight || rect.width === 0 || rect.height === 0) return;

    const imageAspect = naturalWidth / naturalHeight;
    const boxAspect = rect.width / rect.height;
    let drawWidth = rect.width;
    let drawHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (imageAspect > boxAspect) {
      drawHeight = rect.width / imageAspect;
      offsetY = (rect.height - drawHeight) / 2;
    } else {
      drawWidth = rect.height * imageAspect;
      offsetX = (rect.width - drawWidth) / 2;
    }

    const localX = event.clientX - rect.left - offsetX;
    const localY = event.clientY - rect.top - offsetY;
    if (localX < 0 || localY < 0 || localX > drawWidth || localY > drawHeight) return;

    const x = (localX / drawWidth) * controller.layout.width;
    const y = (localY / drawHeight) * controller.layout.height;
    const button = event.button === 2 ? 'right' : 'left';
    try {
      await sandbox.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, controller.cdpSessionId);
      await sandbox.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button, clickCount: 1 },
        controller.cdpSessionId,
      );
      await sandbox.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x, y, button, clickCount: 1 },
        controller.cdpSessionId,
      );
      this.appendLog(controller, `点击 (${Math.round(x)}, ${Math.round(y)})`);
    } catch (error) {
      this.appendLog(controller, `点击失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async forwardKey(controller: InstanceController, event: KeyboardEvent): Promise<void> {
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp) return;
    const modifier = event.ctrlKey || event.metaKey || event.altKey;
    try {
      if (!modifier && event.key.length === 1) {
        await sandbox.cdp.send('Input.insertText', { text: event.key }, controller.cdpSessionId);
        return;
      }
      const spec = KEY_SPECS[event.key];
      if (!spec) return;
      const base = {
        key: event.key,
        code: spec.code,
        windowsVirtualKeyCode: spec.keyCode,
        nativeVirtualKeyCode: spec.keyCode,
        modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0),
      };
      await sandbox.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, controller.cdpSessionId);
      if (spec.text && !event.ctrlKey && !event.metaKey) {
        await sandbox.cdp.send('Input.dispatchKeyEvent', { type: 'char', text: spec.text, ...base }, controller.cdpSessionId);
      }
      await sandbox.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, controller.cdpSessionId);
    } catch (error) {
      this.appendLog(controller, `键盘输入失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async releaseCurrent(): Promise<void> {
    const controller = this.activeController();
    if (!controller) return;
    const profileId = controller.sandbox.profileId;
    const name = controller.sandbox.profileName || controller.profile?.name || profileId;
    try {
      await this.bridge.releaseProfile(profileId);
      await this.workspace.removeMapping(profileId).catch(() => null);
      toast(`已释放「${name}」`, 'success');
      this.closeTab(`instance:${profileId}`, true);
      void this.refreshAll(true);
      void this.refreshWorkspace(true);
    } catch (error) {
      toast(`释放失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  // ------------------------------------------------------------------
  // Cookies
  // ------------------------------------------------------------------
  private openCookies(): void {
    const controller = this.activeController();
    if (!controller) return;
    const sandbox = this.sandboxFor(controller.sandbox.profileId);
    if (!sandbox?.cdp) return;

    const body = el('div', { class: 'form' });
    const output = el('textarea', {
      class: 'input cookie-area',
      attrs: { spellcheck: 'false', placeholder: '点击「读取」后，Cookie JSON 会显示在这里；粘贴 JSON 后点击「注入」' },
    }) as HTMLTextAreaElement;

    const status = el('div', { class: 'small' });
    const actions = el('div', { class: 'row-actions' });

    const run = async (label: string, fn: () => Promise<string>) => {
      status.textContent = `${label}中…`;
      try {
        const message = await fn();
        status.textContent = message;
        toast(message, 'success', 2500);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.textContent = `${label}失败：${message}`;
        toast(`${label}失败：${message}`, 'error', 6000);
      }
    };

    actions.append(
      button('读取全部 Cookie', {
        class: 'btn',
        icon: 'database',
        onClick: () =>
          void run('读取', async () => {
            const result = await sandbox.cdp!.send<{ cookies?: unknown[] }>('Network.getAllCookies', {}, null, 20000);
            const cookies = result.cookies ?? [];
            output.value = JSON.stringify(cookies, null, 2);
            return `已读取 ${cookies.length} 条 Cookie`;
          }),
      }),
      button('注入 Cookie', {
        class: 'btn primary',
        icon: 'upload',
        onClick: () =>
          void run('注入', async () => {
            if (!output.value.trim()) throw new Error('输入框为空，先读取或粘贴 Cookie JSON');
            let parsed: unknown;
            try {
              parsed = JSON.parse(output.value);
            } catch (error) {
              throw new Error('不是合法 JSON');
            }
            const cookies = Array.isArray(parsed) ? parsed : [parsed];
            try {
              await sandbox.cdp!.send('Network.setCookies', { cookies }, null, 20000);
            } catch {
              for (const cookie of cookies) {
                await sandbox.cdp!.send('Network.setCookie', cookie as Record<string, unknown>, null, 20000);
              }
            }
            this.appendLog(controller, `注入 ${cookies.length} 条 Cookie`);
            return `已注入 ${cookies.length} 条 Cookie`;
          }),
      }),
      button('清空 Cookie', {
        class: 'btn danger',
        icon: 'trash',
        onClick: () =>
          void run('清空', async () => {
            await sandbox.cdp!.send('Network.clearBrowserCookies', {}, null, 20000);
            output.value = '';
            this.appendLog(controller, '已清空浏览器 Cookie');
            return '已清空浏览器 Cookie';
          }),
      }),
      button('复制', {
        class: 'btn',
        icon: 'copy',
        onClick: () => {
          if (!output.value) return;
          void navigator.clipboard
            ?.writeText(output.value)
            .then(() => toast('已复制到剪贴板', 'success', 2000))
            .catch(() => toast('剪贴板不可用，请手动选择文本复制', 'warning'));
        },
      }),
    );

    body.append(output, actions, status);
    this.openModal('Cookie 管理', body);
  }

  // ------------------------------------------------------------------
  // Dialogs
  // ------------------------------------------------------------------
  private openModal(title: string, body: HTMLElement, actions: HTMLElement[] = []): HTMLElement {
    const overlay = el('div', { class: 'modal-overlay' });
    const box = el('div', { class: 'modal' });
    const head = el('div', { class: 'modal-head' });
    head.append(
      el('h2', { text: title }),
      iconButton('close', { title: '关闭', onClick: () => overlay.remove() }),
    );
    box.append(head, el('div', { class: 'modal-body' }, body));
    if (actions.length > 0) {
      const footer = el('div', { class: 'modal-actions' });
      for (const action of actions) footer.appendChild(action);
      box.appendChild(footer);
    }
    overlay.appendChild(box);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) overlay.remove();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') overlay.remove();
    });
    this.container.appendChild(overlay);
    return overlay;
  }

  private openSettings(): void {
    const body = el('div', { class: 'form' });

    const portField = el('div', { class: 'field' });
    portField.append(el('label', { text: 'ShardX 本地 API 端口' }));
    const portInput = el('input', {
      class: 'input',
      attrs: { type: 'number', min: '1', max: '65535', step: '1' },
      props: { value: String(this.api.getPort()) },
    }) as HTMLInputElement;
    portField.append(
      portInput,
      el('span', { class: 'hint', text: '默认 40325。端口变更后立即生效，无需重启扩展。' }),
    );

    const tokenField = el('div', { class: 'field' });
    tokenField.append(el('label', { text: 'Bearer Token' }));
    const tokenInput = el('input', {
      class: 'input',
      attrs: {
        type: 'password',
        spellcheck: 'false',
        placeholder: this.api.hasToken() ? '已保存（留空保持不变）' : '粘贴 ShardX 自动化 API Token',
        autocomplete: 'off',
      },
    }) as HTMLInputElement;
    tokenField.append(
      tokenInput,
      el('span', { class: 'hint', text: '留空时点「自动检测」，直接从本机 ShardX 配置读取端口并生成 Token。Token 只保存在扩展存储中，不写日志。' }),
    );

    const status = el('div', { class: 'small' });

    const actions = el('div', { class: 'row-actions' });
    const clearToken = button('清除 Token', {
      class: 'btn danger',
      onClick: () =>
        void (async () => {
          await this.api.setToken(null);
          tokenInput.value = '';
          tokenInput.placeholder = '粘贴 ShardX 自动化 API Token';
          toast('Token 已清除', 'success');
        })(),
    });

    const test = button('测试连接', {
      class: 'btn',
      icon: 'server',
      onClick: () =>
        void (async () => {
          status.textContent = '连接中…';
          try {
            await this.api.setPort(Number(portInput.value));
            await this.api.health();
            status.textContent = `连接成功：${this.api.baseUrl()}`;
            toast('ShardX API 连接正常', 'success');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            status.textContent = `连接失败：${message}`;
            toast(message, 'error', 7000);
          }
        })(),
    });

    const detect = button('自动检测', {
      class: 'btn',
      icon: 'refresh',
      onClick: () =>
        void (async () => {
          status.textContent = '正在读取本机 ShardX 配置…';
          try {
            const info = await this.api.discover();
            if (!info.found) {
              status.textContent = `未检测到：${info.reason ?? '未知原因'}`;
              toast(info.reason ?? '未检测到 ShardX', 'error', 7000);
              return;
            }
            portInput.value = String(info.port ?? '');
            await this.api.applyDiscovered(info);
            tokenInput.value = '';
            tokenInput.placeholder = '已自动生成并保存，无需手填';
            const state = info.running === false ? '启动器未运行' : `API ${info.version || '已响应'}`;
            status.textContent = `已读取 ${info.settingsPath ?? ''} · ${state}`;
            toast(`已自动配置 ShardX（端口 ${info.port}）`, 'success');
            this.updateApiStatus();
            await this.refreshAll(true);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            status.textContent = `检测失败：${message}`;
            toast(message, 'error', 7000);
          }
        })(),
    });

    const save = button('保存并刷新', {
      class: 'btn primary',
      icon: 'check',
      onClick: () =>
        void (async () => {
          try {
            const port = Number(portInput.value);
            await this.api.setPort(port);
            const token = tokenInput.value.trim();
            if (token) await this.api.setToken(token);
            status.textContent = '设置已保存';
            toast('设置已保存', 'success');
            this.updateApiStatus();
            await this.refreshAll(true);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            status.textContent = message;
            toast(message, 'error');
          }
        })(),
    });

    actions.append(detect, test, clearToken, save);
    body.append(portField, tokenField, actions, status);
    this.openModal('ShardX API 设置', body);
  }

  private openCreateDialog(): void {
    const body = el('div', { class: 'form' });

    const nameField = el('div', { class: 'field' });
    nameField.append(el('label', { text: '实例名称' }));
    const nameInput = el('input', {
      class: 'input',
      attrs: { type: 'text', placeholder: `shardx-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}` },
    }) as HTMLInputElement;
    nameField.appendChild(nameInput);

    const platformField = el('div', { class: 'field' });
    platformField.append(el('label', { text: '指纹平台' }));
    const platformSelect = el('select', { class: 'select' }) as HTMLSelectElement;
    for (const [value, label] of [
      ['win', 'Windows'],
      ['mac', 'macOS'],
      ['linux', 'Linux'],
    ]) {
      platformSelect.appendChild(el('option', { text: label, attrs: { value } }));
    }
    platformField.appendChild(platformSelect);

    const proxyField = el('div', { class: 'field' });
    proxyField.append(el('label', { text: '代理（可选）' }));
    const proxySelect = el('select', { class: 'select' }) as HTMLSelectElement;
    proxySelect.appendChild(el('option', { text: '直连，不使用代理', attrs: { value: '' } }));
    for (const proxy of this.proxies) {
      proxySelect.appendChild(
        el('option', {
          text: `${(proxy as any).name ?? (proxy as any).id} · ${proxyText(proxy)}`,
          attrs: { value: str((proxy as any).id) },
        }),
      );
    }
    proxyField.appendChild(proxySelect);

    const sessionField = el('div', { class: 'field' });
    sessionField.append(el('label', { text: '绑定到会话' }));
    const sessionInput = el('input', {
      class: 'input',
      attrs: { type: 'text' },
      props: { value: this.sessionId },
    }) as HTMLInputElement;
    sessionField.append(sessionInput, el('span', { class: 'hint', text: '同一 profile 只能被一个会话独占。' }));

    const status = el('div', { class: 'small' });
    const actions = el('div', { class: 'row-actions' });
    const create = button('创建并启动', {
      class: 'btn primary',
      icon: 'rocket',
      onClick: () =>
        void (async () => {
          create.disabled = true;
          status.textContent = '创建中…';
          try {
            const name = nameInput.value.trim() || `shardx-${Date.now().toString(36)}`;
            const platform = platformSelect.value as 'win' | 'mac' | 'linux';
            const proxyId = proxySelect.value;
            const base: Record<string, unknown> = { name, platform };
            if (proxyId) base.proxy_id = proxyId;

            let profile: Profile;
            try {
              profile = await this.api.createProfile(base);
            } catch (firstError) {
              const template = await this.api.fingerprintTemplate(platform);
              profile = await this.api.createProfile({ ...base, fingerprint: template });
            }

            status.textContent = `已创建 ${profile.name || profile.id}，正在启动…`;
            const sessionId = sessionInput.value.trim() || this.sessionId;
            const sandbox = await this.bridge.startSessionProfile(sessionId, profile.id, profile.name || profile.id);
            this.openInstanceTab(sandbox, profile);
            toast(`实例「${profile.name || profile.id}」已启动`, 'success');
            const overlay = status.closest('.modal-overlay');
            overlay?.remove();
            await this.refreshAll(true);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            status.textContent = `失败：${message}`;
            toast(message, 'error', 7000);
          } finally {
            create.disabled = false;
          }
        })(),
    });

    actions.append(create);
    body.append(nameField, platformField, proxyField, sessionField, actions, status);
    this.openModal('快速新建并启动实例', body);
  }
}
