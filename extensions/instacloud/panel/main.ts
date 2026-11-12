import { connectHost } from '@openchamber/sdk';
import type { GuestConnection, HostClient, HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { Api, ApiError } from './api';
import type { Ctx } from './context';
import type { Org, Project, State, Tab } from './types';
import {
  badge,
  button,
  clear,
  confirmDialog,
  copyToClipboard,
  el,
  emptyState,
  errorMessage,
  icon,
  iconButton,
  note,
  openModal,
  promptDialog,
  shortId,
  statusInfo,
  toast,
} from './util';
import { mountBranches } from './views/branches';
import { mountDeploy } from './views/deploy';
import { mountLogs } from './views/logs';
import { mountMetrics } from './views/metrics';
import { mountServices } from './views/services';
import { mountTerminal } from './views/terminal';

const host: HostClient = connectHost();
const api = new Api(host);

const state: State = {
  screen: 'boot',
  error: null,
  me: null,
  orgs: [],
  orgId: null,
  projects: [],
  projectId: null,
  branches: [],
  branch: null,
  services: [],
  regions: [],
  serviceId: null,
  tab: 'services',
  settings: {},
  term: {},
  helpOpen: false,
};

let connection: GuestConnection | null = null;
let booting = false;
let refreshing = false;
let detailLoading = false;
let detailError: string | null = null;
let authError: string | null = null;
let cleanup: (() => void) | null = null;
let retryTimer: number | null = null;
let retryAttempt = 0;
let reconnecting = false;

const RETRY_DELAYS = [1500, 3000, 6000, 12000, 20000];

function clearRetry(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryAttempt = 0;
}

function scheduleRetry(): void {
  if (retryTimer !== null || authError || !connection?.connected) return;
  const delay = RETRY_DELAYS[Math.min(retryAttempt, RETRY_DELAYS.length - 1)];
  retryAttempt += 1;
  reconnecting = true;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (booting) {
      scheduleRetry();
      return;
    }
    void boot();
  }, delay);
  render();
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'services', label: '服务', icon: 'server' },
  { id: 'deploy', label: '部署', icon: 'rocket' },
  { id: 'logs', label: '日志', icon: 'logs' },
  { id: 'metrics', label: '指标', icon: 'chart' },
  { id: 'terminal', label: '终端', icon: 'terminal' },
  { id: 'branches', label: '分支', icon: 'branch' },
];

function readPref(key: string): Promise<string | null> {
  return host.storage
    .get(key)
    .then((value) => (typeof value === 'string' ? value : null))
    .catch(() => null);
}

function savePref(key: string, value: string | null): void {
  if (value) void host.storage.set(key, value).catch(() => undefined);
  else void host.storage.delete(key).catch(() => undefined);
}

function isAuthError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (
      error.status === 401 ||
      error.status === 403 ||
      error.code === 'DISCONNECTED' ||
      error.code === 'NO_INTEGRATION'
    );
  }
  return false;
}

function currentOrg(): Org | null {
  return state.orgs.find((org) => org.id === state.orgId) ?? null;
}

function currentProject(): Project | null {
  return state.projects.find((project) => project.id === state.projectId) ?? null;
}

function accountLabel(): string {
  return state.me?.user?.email || connection?.account || 'InstaCloud';
}

function avatarLetter(): string {
  const label = accountLabel();
  return (label[0] ?? 'I').toUpperCase();
}

function topbar(): HTMLElement {
  const orgSelect = el('select', { class: 'select', title: '切换组织' });
  for (const org of state.orgs) {
    orgSelect.appendChild(
      el('option', {
        text: org.name,
        attrs: { value: org.id },
        props: { selected: org.id === state.orgId },
      }),
    );
  }
  orgSelect.style.maxWidth = '200px';
  orgSelect.style.width = 'auto';
  orgSelect.addEventListener('change', () => {
    if (orgSelect.value) void selectOrg(orgSelect.value);
  });

  const account = el(
    'div',
    { class: 'account', title: accountLabel() },
    el('span', { class: 'avatar', text: avatarLetter() }),
    el('span', { class: 'account-name', text: accountLabel() }),
    state.me?.token?.scope ? el('span', { class: 'scope', text: state.me.token.scope }) : null,
  );

  return el(
    'header',
    { class: 'topbar' },
    el(
      'div',
      { class: 'brand' },
      el('span', { class: 'brand-mark' }, icon('cloud', 17)),
      el(
        'div',
        { class: 'brand-text' },
        el('strong', { text: 'InstaCloud' }),
        el('span', { text: 'OpenChamber 扩展' }),
      ),
    ),
    state.orgs.length ? orgSelect : el('span', { class: 'small muted', text: '加载组织…' }),
    el('div', { class: 'topbar-spacer' }),
    el(
      'div',
      { class: 'topbar-right' },
      account,
      iconButton('info', { title: '帮助与限制', onClick: () => openHelp() }),
      iconButton('refresh', { title: '刷新全部数据', onClick: () => void refreshAll() }),
    ),
  );
}

function sidebar(): HTMLElement {
  const org = currentOrg();
  const list = el('div', { class: 'project-list' });
  for (const project of state.projects) {
    const status = statusInfo(project.status);
    const item = el(
      'button',
      {
        class: `project-item${project.id === state.projectId ? ' active' : ''}`,
        attrs: { type: 'button', title: project.name },
        on: {
          click: () => {
            if (project.id !== state.projectId) void openProject(project.id);
          },
        },
      },
      el('span', {
        class: `dot ${status.tone === 'success' ? 'ok' : status.tone === 'error' ? 'err' : status.tone === 'warning' ? 'warn' : 'muted'}`,
      }),
      el('span', { class: 'project-name', text: project.name }),
    );
    list.appendChild(item);
  }
  if (!state.projects.length) {
    list.appendChild(
      el('div', { class: 'empty', attrs: { style: 'padding:18px 10px' } },
        el('span', { class: 'small muted', text: '还没有项目' }),
      ),
    );
  }

  const balance = org?.balance_micros ? Number(org.balance_micros) / 1_000_000 : null;
  return el(
    'aside',
    { class: 'sidebar' },
    el(
      'div',
      { class: 'sidebar-head' },
      el('span', { class: 'strong small', text: '项目' }),
      el('span', { class: 'count', text: String(state.projects.length) }),
      el('div', { class: 'grow' }),
      iconButton('plus', {
        title: '新建项目',
        onClick: () => void createProject(),
      }),
    ),
    list,
    el(
      'div',
      { class: 'sidebar-foot' },
      el('strong', { text: org?.name ?? 'InstaCloud' }),
      el(
        'span',
        {
          text: [
            org?.tier ? `${org.tier} 套餐` : '组织',
            balance !== null && Number.isFinite(balance) ? `余额 $${balance.toFixed(2)}` : null,
            `${state.projects.length} 个项目`,
          ]
            .filter(Boolean)
            .join(' · '),
        },
      ),
    ),
  );
}

function projectHead(project: Project): HTMLElement {
  const status = statusInfo(project.status);
  const branchSelect = el('select', { class: 'select', title: '当前分支' });
  for (const branch of state.branches) {
    branchSelect.appendChild(
      el('option', {
        text: branch.name + (branch.is_default ? '（默认）' : ''),
        attrs: { value: branch.name },
        props: { selected: branch.name === state.branch },
      }),
    );
  }
  branchSelect.style.width = 'auto';
  branchSelect.style.maxWidth = '190px';
  branchSelect.addEventListener('change', () => {
    state.branch = branchSelect.value;
    render();
  });

  return el(
    'div',
    { class: 'project-head' },
    el(
      'div',
      { class: 'title-row' },
      el('h1', { text: project.name }),
      project.status ? badge(status.label, status.tone, true) : null,
      el(
        'span',
        { class: 'id', title: project.id },
        el('span', { text: shortId(project.id) }),
        iconButton('copy', {
          title: '复制项目 ID',
          onClick: () => copy(project.id),
        }),
      ),
      el('div', { class: 'spacer' }),
      iconButton('refresh', { title: '刷新项目', onClick: () => void refreshProject() }),
      iconButton('trash', {
        title: '删除项目',
        class: 'danger',
        onClick: () => void removeProject(project),
      }),
    ),
    el(
      'div',
      { class: 'sub-row' },
      el('span', { class: 'subtle', text: '分支' }),
      state.branches.length
        ? branchSelect
        : el('span', { class: 'small muted', text: '加载中…' }),
      el('span', { class: 'sep' }),
      el('span', {
        class: 'small',
        text: `${state.services.length} 个服务`,
      }),
      project.region
        ? [el('span', { class: 'sep' }), el('span', { class: 'small', text: project.region })]
        : null,
    ),
  );
}

function tabsBar(): HTMLElement {
  const bar = el('nav', { class: 'tabs' });
  for (const tab of TABS) {
    const count =
      tab.id === 'services'
        ? state.services.length
        : tab.id === 'branches'
          ? state.branches.length
          : null;
    const node = el(
      'button',
      {
        class: `tab${state.tab === tab.id ? ' active' : ''}`,
        attrs: { type: 'button' },
        on: {
          click: () => {
            if (state.tab !== tab.id) setTab(tab.id);
          },
        },
      },
      icon(tab.icon, 13),
      el('span', { text: tab.label }),
      count !== null && count > 0 ? el('span', { class: 'tab-count', text: String(count) }) : null,
    );
    bar.appendChild(node);
  }
  return bar;
}

function mainPanel(): HTMLElement {
  const main = el('main', { class: 'main' });
  if (detailLoading) {
    main.appendChild(
      el(
        'div',
        { class: 'project-head' },
        el('div', { class: 'skeleton', attrs: { style: 'width:220px;height:22px' } }),
        el('div', { class: 'skeleton', attrs: { style: 'width:320px;height:12px;margin-top:8px' } }),
      ),
    );
    main.appendChild(
      el(
        'div',
        { class: 'tab-panel' },
        el(
          'div',
          { class: 'service-grid' },
          ...[0, 1, 2].map(() =>
            el('div', { class: 'skeleton', attrs: { style: 'height:140px' } }),
          ),
        ),
      ),
    );
    return main;
  }

  const project = currentProject();
  if (!project) {
    main.appendChild(
      emptyState({
        icon: 'box',
        title: '选择一个项目',
        body: '从左侧选择项目，或创建一个新项目来部署服务。',
        action: button('新建项目', {
          class: 'btn primary',
          icon: 'plus',
          onClick: () => void createProject(),
        }),
      }),
    );
    return main;
  }

  main.appendChild(projectHead(project));
  main.appendChild(tabsBar());
  const panel = el('div', { class: 'tab-panel' });
  if (detailError) {
    panel.appendChild(el('div', { class: 'error-box', text: detailError }));
    panel.appendChild(
      button('重试加载项目', {
        class: 'btn',
        icon: 'refresh',
        onClick: () => void refreshProject(),
      }),
    );
    main.appendChild(panel);
    return main;
  }
  main.appendChild(panel);
  cleanup = mountView(panel, state.tab);
  return main;
}

function mountView(panel: HTMLElement, tab: Tab): () => void {
  switch (tab) {
    case 'services':
      return mountServices(panel, ctx);
    case 'deploy':
      return mountDeploy(panel, ctx);
    case 'logs':
      return mountLogs(panel, ctx);
    case 'metrics':
      return mountMetrics(panel, ctx);
    case 'terminal':
      return mountTerminal(panel, ctx);
    case 'branches':
      return mountBranches(panel, ctx);
    default:
      return () => {};
  }
}

function connectionBanner(): HTMLElement | null {
  if (state.screen !== 'ready') return null;
  const connected = connection?.connected ?? false;
  if (connected && !state.error && !reconnecting) return null;
  const text = !connected
    ? 'OpenChamber 与扩展的连接已中断，正在等待重连…'
    : reconnecting
      ? '网络请求失败，正在自动重试…'
      : `刷新失败：${state.error ?? '未知错误'}`;
  return el(
    'div',
    { class: 'conn-banner' },
    el('span', { class: 'spinner' }),
    el('span', { class: 'conn-text', text }),
    button('立即重试', {
      class: 'btn small',
      onClick: () => {
        clearRetry();
        reconnecting = false;
        void boot();
      },
    }),
  );
}

function render(): void {
  cleanup?.();
  cleanup = null;
  const app = document.getElementById('app');
  if (!app) return;
  clear(app);

  if (state.screen === 'boot') {
    app.appendChild(
      el(
        'div',
        { class: 'boot' },
        el('span', { class: 'mark' }, icon('cloud', 24)),
        el('strong', { text: 'InstaCloud' }),
        el('span', { class: 'small', text: '正在连接 OpenChamber 主机…' }),
        el('span', { class: 'spinner large' }),
      ),
    );
    return;
  }

  if (state.screen === 'disconnected') {
    app.appendChild(disconnectedScreen());
    return;
  }

  if (state.screen === 'error') {
    app.appendChild(errorScreen());
    return;
  }

  const shell = el('div', { class: 'app' });
  const banner = connectionBanner();
  if (banner) shell.appendChild(banner);
  shell.appendChild(topbar());
  const workspace = el('div', { class: 'workspace' });
  workspace.appendChild(sidebar());
  workspace.appendChild(mainPanel());
  shell.appendChild(workspace);
  app.appendChild(shell);
}

function disconnectedScreen(): HTMLElement {
  const retry = button('重新检测', {
    class: 'btn primary',
    icon: 'refresh',
    onClick: () => void boot(),
  });
  const openConsole = button('打开 InstaCloud 控制台', {
    class: 'btn',
    icon: 'external',
    onClick: () => void host.openUrl('https://console.instacloud.com'),
  });
  return el(
    'div',
    { class: 'disconnected' },
    el(
      'div',
      { class: 'disconnected-card' },
      el(
        'div',
        { class: 'disconnected-head' },
        el('span', { class: 'mark' }, icon('cloud', 22)),
        el(
          'div',
          {},
          el('h1', { text: '连接 InstaCloud' }),
          el('p', { text: '需要一个组织作用域的 API 令牌（insta_ 开头）。' }),
        ),
      ),
      connection?.connected
        ? note('OpenChamber 集成已连接，但令牌验证未通过。请检查令牌是否被撤销或缺少组织权限。', 'warn')
        : note('OpenChamber 尚未连接此集成。', 'info'),
      authError ? el('div', { class: 'error-box', text: authError }) : null,
      el(
        'div',
        { class: 'steps' },
        el(
          'div',
          { class: 'step' },
          el('span', { class: 'step-num', text: '1' }),
          el('span', {}, '打开 OpenChamber 的 ', el('strong', { text: '设置 → 集成 → InstaCloud' }), '。'),
        ),
        el(
          'div',
          { class: 'step' },
          el('span', { class: 'step-num', text: '2' }),
          el(
            'span',
            {},
            '在 InstaCloud 控制台的 API 令牌页面创建令牌，作用域选择组织（不要使用个人令牌）。',
          ),
        ),
        el(
          'div',
          { class: 'step' },
          el('span', { class: 'step-num', text: '3' }),
          el(
            'span',
            {},
            '粘贴 ',
            el('code', { text: 'insta_…' }),
            ' 并保存。令牌由 OpenChamber 保存，本页面不会读取或显示它。',
          ),
        ),
        el(
          'div',
          { class: 'step' },
          el('span', { class: 'step-num', text: '4' }),
          el('span', {}, '回到此面板点击“重新检测”。'),
        ),
      ),
      el('div', { class: 'modal-actions', attrs: { style: 'justify-content:flex-start' } }, openConsole, retry),
    ),
  );
}

function errorScreen(): HTMLElement {
  return el(
    'div',
    { class: 'disconnected' },
    el(
      'div',
      { class: 'disconnected-card' },
      el(
        'div',
        { class: 'disconnected-head' },
        el('span', { class: 'mark' }, icon('alert', 22)),
        el(
          'div',
          {},
          el('h1', { text: '加载失败' }),
          el('p', {
            text: reconnecting ? '网络连接失败，正在自动重试…' : '无法从 InstaCloud 读取数据。',
          }),
        ),
      ),
      el('div', { class: 'error-box', text: state.error ?? '未知错误' }),
      el(
        'div',
        { class: 'modal-actions', attrs: { style: 'justify-content:flex-start' } },
        button('重试', { class: 'btn primary', icon: 'refresh', onClick: () => void boot() }),
        button('查看连接说明', {
          class: 'btn',
          onClick: () => {
            state.screen = 'disconnected';
            render();
          },
        }),
      ),
    ),
  );
}

function openHelp(): void {
  const body = el(
    'div',
    { class: 'form' },
    el('p', {
      class: 'card-note',
      text: '此扩展直接调用 InstaCloud REST API，所有请求经 OpenChamber 主机转发，令牌不会进入页面上下文。',
    }),
    el(
      'div',
      { class: 'kv' },
      el('span', { class: 'k', text: 'API' }),
      el('span', { class: 'v mono', text: 'https://api.instacloud.com' }),
      el('span', { class: 'k', text: '令牌' }),
      el('span', { class: 'v', text: state.me?.token?.scope ?? '组织作用域' }),
      el('span', { class: 'k', text: '组织' }),
      el('span', { class: 'v', text: currentOrg()?.name ?? '—' }),
    ),
    el('h3', { text: '能做什么' }),
    el('div', {
      class: 'card-note',
      text: '创建/删除项目；创建、启停、重启、删除 compute 与数据库服务；部署容器镜像或公开 GitHub 仓库；查看日志与指标；在 compute 内执行一次性命令；创建/删除分支。',
    }),
    el('h3', { text: '限制' }),
    el('div', {
      class: 'card-note',
      text: '1. 终端不是交互式 PTY，每次命令最长 15 秒；SSH 需要人工登录会话，API 令牌无法建立 SSH。\n2. GitHub 部署仅支持公开仓库；私有仓库需要 GitHub App。\n3. 不支持直接上传本地目录，请先构建并推送镜像，或使用公开仓库。\n4. 日志与指标为轮询，不是实时流。',
    }),
    el(
      'div',
      { class: 'modal-actions', attrs: { style: 'justify-content:flex-start' } },
      button('打开 InstaCloud 控制台', {
        class: 'btn',
        icon: 'external',
        onClick: () => void host.openUrl('https://console.instacloud.com'),
      }),
    ),
  );
  const modal = openModal({ title: 'InstaCloud 扩展', body, wide: true });
  const close = button('关闭', { class: 'btn primary' });
  close.addEventListener('click', () => modal.close());
  modal.modal.appendChild(el('div', { class: 'modal-foot' }, el('div', { class: 'modal-actions' }, close)));
}

async function boot(): Promise<void> {
  if (booting) return;
  booting = true;
  const hadData = state.me !== null && state.orgs.length > 0;
  authError = null;
  if (!hadData) {
    state.error = null;
    state.screen = 'boot';
    render();
  }
  if (!connection?.connected) {
    if (hadData) {
      reconnecting = true;
      render();
    } else {
      state.screen = 'disconnected';
      render();
    }
    booting = false;
    return;
  }
  try {
    const [me, orgsResponse, regionsResponse] = await Promise.all([
      api.me(),
      api.orgs(),
      api.regions().catch(() => ({ regions: [] })),
    ]);
    state.me = me;
    state.orgs = orgsResponse.orgs ?? [];
    state.regions = regionsResponse.regions ?? [];
    if (!state.orgs.length) {
      clearRetry();
      reconnecting = false;
      state.screen = 'error';
      state.error = '当前令牌没有可访问的组织。请使用组织作用域令牌。';
      render();
      return;
    }
    const savedOrg = await readPref('lastOrg');
    const tokenOrg = me.token?.orgId ?? null;
    const preferred =
      state.orgs.find((org) => org.id === savedOrg) ??
      state.orgs.find((org) => org.id === state.settings['default-org']) ??
      state.orgs.find((org) => org.id === tokenOrg) ??
      state.orgs[0];
    state.orgId = preferred.id;
    savePref('lastOrg', preferred.id);
    const projectsResponse = await api.projects(preferred.id);
    state.projects = projectsResponse.projects ?? [];
    const savedProject = await readPref('lastProject');
    const target =
      state.projects.find((project) => project.id === savedProject) ??
      state.projects[0] ??
      null;
    if (target) {
      try {
        await loadProjectData(target.id);
        savePref('lastProject', target.id);
        detailError = null;
      } catch (error) {
        if (isAuthError(error)) throw error;
        detailError = errorMessage(error);
      }
    }
    state.screen = 'ready';
    clearRetry();
    reconnecting = false;
    state.error = null;
    render();
  } catch (error) {
    if (isAuthError(error)) {
      clearRetry();
      reconnecting = false;
      authError = errorMessage(error);
      state.screen = 'disconnected';
    } else {
      state.error = errorMessage(error);
      state.screen = hadData ? 'ready' : 'error';
      reconnecting = true;
      scheduleRetry();
    }
    render();
  } finally {
    booting = false;
  }
}

async function loadProjectData(projectId: string): Promise<void> {
  const [branchesResponse, servicesResponse] = await Promise.all([
    api.branches(projectId),
    api.services(projectId),
  ]);
  const branches = branchesResponse.branches ?? [];
  const services = servicesResponse.services ?? [];
  const defaultBranch = branches.find((branch) => branch.is_default) ?? branches[0] ?? null;
  const branchStillExists =
    state.projectId === projectId && state.branch
      ? branches.some((branch) => branch.name === state.branch)
      : false;
  state.projectId = projectId;
  state.branches = branches;
  state.services = services;
  state.branch = branchStillExists ? state.branch : (defaultBranch?.name ?? null);
  if (!services.some((service) => service.id === state.serviceId)) {
    state.serviceId = services.find((service) => service.type === 'compute')?.id ?? services[0]?.id ?? null;
  }
  detailError = null;
}

async function openProject(projectId: string): Promise<void> {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  detailLoading = true;
  detailError = null;
  state.projectId = projectId;
  render();
  try {
    await loadProjectData(projectId);
    savePref('lastProject', projectId);
  } catch (error) {
    if (isAuthError(error)) {
      authError = errorMessage(error);
      state.screen = 'disconnected';
    } else {
      detailError = errorMessage(error);
    }
  } finally {
    detailLoading = false;
    render();
  }
}

async function selectOrg(orgId: string): Promise<void> {
  if (orgId === state.orgId && state.projects.length) return;
  state.orgId = orgId;
  state.projects = [];
  state.projectId = null;
  state.branches = [];
  state.services = [];
  state.branch = null;
  state.serviceId = null;
  detailError = null;
  detailLoading = true;
  savePref('lastOrg', orgId);
  savePref('lastProject', null);
  render();
  try {
    const response = await api.projects(orgId);
    state.projects = response.projects ?? [];
    const first = state.projects[0];
    if (first) {
      await loadProjectData(first.id);
      savePref('lastProject', first.id);
    }
  } catch (error) {
    if (isAuthError(error)) {
      authError = errorMessage(error);
      state.screen = 'disconnected';
    } else {
      toast(errorMessage(error), 'error');
    }
  } finally {
    detailLoading = false;
    render();
  }
}

async function refreshAll(): Promise<void> {
  if (refreshing || booting) return;
  refreshing = true;
  try {
    const [me, orgsResponse] = await Promise.all([api.me(), api.orgs()]);
    state.me = me;
    state.orgs = orgsResponse.orgs ?? [];
    if (!state.orgId || !state.orgs.some((org) => org.id === state.orgId)) {
      state.orgId = state.orgs[0]?.id ?? null;
    }
    if (!state.orgId) {
      clearRetry();
      reconnecting = false;
      state.screen = 'error';
      state.error = '当前令牌没有可访问的组织。';
      return;
    }
    const projectsResponse = await api.projects(state.orgId);
    state.projects = projectsResponse.projects ?? [];
    if (state.projectId && !state.projects.some((project) => project.id === state.projectId)) {
      state.projectId = null;
      state.branches = [];
      state.services = [];
      state.branch = null;
      state.serviceId = null;
      savePref('lastProject', null);
    }
    if (state.projectId) {
      detailError = null;
      try {
        await loadProjectData(state.projectId);
      } catch (error) {
        detailError = errorMessage(error);
      }
    }
    toast('已刷新', 'success');
    clearRetry();
    reconnecting = false;
    state.error = null;
  } catch (error) {
    if (isAuthError(error)) {
      clearRetry();
      reconnecting = false;
      authError = errorMessage(error);
      state.screen = 'disconnected';
    } else {
      state.error = errorMessage(error);
      toast(errorMessage(error), 'error');
      if (state.me) scheduleRetry();
    }
  } finally {
    refreshing = false;
    render();
  }
}

async function refreshProject(): Promise<void> {
  if (!state.projectId) return;
  detailError = null;
  try {
    await loadProjectData(state.projectId);
    savePref('lastProject', state.projectId);
    clearRetry();
    reconnecting = false;
    state.error = null;
    toast('项目已刷新', 'success');
  } catch (error) {
    detailError = errorMessage(error);
    toast(errorMessage(error), 'error');
  }
  render();
}

async function createProject(): Promise<void> {
  if (!state.orgId) {
    toast('没有可用的组织。', 'error');
    return;
  }
  const name = await promptDialog({
    title: '新建项目',
    label: '项目名称',
    placeholder: 'my-project',
    hint: '项目会创建在当前组织中，并带有默认分支。',
    confirmLabel: '创建项目',
    validate: (value) =>
      value.length > 60 ? '名称不能超过 60 个字符。' : null,
  });
  if (!name) return;
  try {
    const response = await api.createProject(state.orgId, name);
    toast(`已创建项目 ${name}`, 'success');
    const projectsResponse = await api.projects(state.orgId);
    state.projects = projectsResponse.projects ?? [];
    const project =
      response.project ??
      state.projects.find((item) => item.name === name) ??
      state.projects[0];
    if (project) await openProject(project.id);
    else render();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

async function removeProject(project: Project): Promise<void> {
  const confirmed = await confirmDialog({
    title: `删除项目 ${project.name}`,
    message:
      '项目内的所有服务、数据卷、分支与路由都会被删除，且无法恢复。请确认这是你要删除的项目。',
    confirmLabel: '永久删除项目',
    danger: true,
    requireText: project.name,
  });
  if (!confirmed) return;
  let submitted = false;
  try {
    await api.deleteProject(project.id);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'HOST_TIMEOUT') {
      submitted = true;
      toast('删除请求超时，服务端可能仍在清理。稍后刷新确认。', 'warning');
    } else {
      toast(errorMessage(error), 'error');
      return;
    }
  }
  state.projects = state.projects.filter((item) => item.id !== project.id);
  if (state.projectId === project.id) {
    state.projectId = null;
    state.branches = [];
    state.services = [];
    state.branch = null;
    state.serviceId = null;
    savePref('lastProject', null);
  }
  if (!submitted) toast(`已删除项目 ${project.name}`, 'success');
  render();
  if (submitted) window.setTimeout(() => void refreshAll(), 4000);
}

function closeProject(): void {
  state.projectId = null;
  state.branches = [];
  state.services = [];
  state.branch = null;
  state.serviceId = null;
  savePref('lastProject', null);
  render();
}

function setTab(tab: Tab): void {
  state.tab = tab;
  render();
}

function copy(text: string): void {
  if (!text) return;
  void host.writeClipboard(text).catch(() => copyToClipboard(text));
  toast('已复制', 'success');
}

const ctx: Ctx = {
  host,
  api,
  state,
  render,
  setTab,
  selectService: (serviceId) => {
    state.serviceId = serviceId;
  },
  refreshProject,
  selectOrg,
  openProject,
  closeProject,
  copy,
};

host.onReady((ready: HostReadyContext) => {
  applyHostReady(ready, document.documentElement);
  connection = ready.connection;
  state.settings = ready.settings ?? {};
  if (!ready.connection.connected) {
    if (state.me) {
      reconnecting = true;
      render();
    } else {
      state.screen = 'disconnected';
      render();
    }
    return;
  }
  void boot();
});

host.onConnection((next: GuestConnection) => {
  const wasConnected = connection?.connected ?? false;
  connection = next;
  if (!next.connected) {
    authError = null;
    reconnecting = state.me !== null;
    if (!state.me) state.screen = 'disconnected';
    render();
  } else if (!wasConnected) {
    void boot();
  }
});

host.onSettings((settings) => {
  state.settings = settings ?? {};
  if (state.screen === 'ready') render();
});

render();
