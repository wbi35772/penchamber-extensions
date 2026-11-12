import { ShardXApiClient } from '../panel/api';
import { SessionIsolationRouter } from '../panel/router';
import { ShardXTabWorkspaceUI } from '../panel/ui';
import type { SessionSandbox } from '../panel/router';
import { transport } from '../panel/transport';
import type { Profile, Proxy, TargetInfo } from '../panel/types';

const store = new Map<string, string>();

/**
 * The launcher mirror speaks CDP through the bridge service. The preview has no
 * service, so this fake answers the same routes with one synthetic frame so the
 * mirror layout can be reviewed without a live launcher.
 */
let mirrorEvents: Array<Record<string, unknown>> = [];
let mirrorFrame: string | null = null;

function drawLauncherFrame(): string {
  if (mirrorFrame !== null) return mirrorFrame;
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, 1280, 800);
  ctx.fillStyle = '#141824';
  ctx.fillRect(0, 0, 250, 800);
  ctx.fillStyle = '#1b2233';
  ctx.fillRect(250, 0, 1030, 64);
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(250, 63, 1030, 1);

  ctx.fillStyle = '#e5edf8';
  ctx.font = '600 22px "Segoe UI", "Microsoft YaHei UI", sans-serif';
  ctx.fillText('ShardBrowser', 24, 42);
  ctx.fillStyle = '#5b6779';
  ctx.font = '12px "Segoe UI", "Microsoft YaHei UI", sans-serif';
  ctx.fillText('指纹浏览器 · 全部配置', 24, 64);

  const menu = ['全部配置', '代理管理', '扩展插件', '应用设置', '关于'];
  menu.forEach((item, index) => {
    const y = 108 + index * 44;
    if (index === 0) {
      ctx.fillStyle = '#1c2740';
      ctx.fillRect(12, y - 22, 226, 36);
      ctx.fillStyle = '#60a5fa';
    } else {
      ctx.fillStyle = '#8b98ad';
    }
    ctx.font = `${index === 0 ? '600 ' : ''}13px "Segoe UI", "Microsoft YaHei UI", sans-serif`;
    ctx.fillText(item, 26, y);
  });

  ctx.fillStyle = '#e5edf8';
  ctx.font = '600 20px "Segoe UI", "Microsoft YaHei UI", sans-serif';
  ctx.fillText('全部配置', 282, 40);
  ctx.fillStyle = '#8b98ad';
  ctx.font = '12px "Segoe UI", "Microsoft YaHei UI", sans-serif';
  ctx.fillText('22 个环境 · 2 个运行中', 400, 40);

  ctx.fillStyle = '#10141f';
  ctx.strokeStyle = '#1f2937';
  ctx.beginPath();
  ctx.roundRect(282, 86, 960, 40, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#5b6779';
  ctx.font = '12px "Segoe UI", "Microsoft YaHei UI", sans-serif';
  ctx.fillText('搜索环境名称、备注或分组', 300, 111);

  const rows = [
    ['7-b5wku4o799r7vz@gmail.com', 'Google', 'ANGLE (NVIDIA GeForce GT 1030)', '运行中', '#10b981'],
    ['Google Ads 01', 'Google', 'ANGLE (NVIDIA GeForce GT 1030)', '已停止', '#5b6779'],
    ['TikTok 矩阵 01', '新账号', 'ANGLE (Intel UHD Graphics 630)', '已停止', '#5b6779'],
    ['Amazon 卖家', '未分类', 'ANGLE (AMD Radeon RX 580)', '运行中', '#10b981'],
    ['eBay 小号', '未分类', 'ANGLE (NVIDIA GeForce RTX 3060)', '已停止', '#5b6779'],
  ];
  rows.forEach((row, index) => {
    const y = 156 + index * 66;
    ctx.fillStyle = index % 2 === 0 ? '#121828' : '#0f1420';
    ctx.fillRect(282, y, 960, 58);
    ctx.strokeStyle = '#1b2436';
    ctx.strokeRect(282, y, 960, 58);
    ctx.fillStyle = '#e5edf8';
    ctx.font = '600 13px "Segoe UI", "Microsoft YaHei UI", sans-serif';
    ctx.fillText(row[0], 302, y + 24);
    ctx.fillStyle = '#5b6779';
    ctx.font = '11px "Segoe UI", "Microsoft YaHei UI", sans-serif';
    ctx.fillText(row[2], 302, y + 43);
    ctx.fillStyle = '#8b98ad';
    ctx.font = '11px "Segoe UI", "Microsoft YaHei UI", sans-serif';
    ctx.fillText(row[1], 720, y + 32);
    ctx.fillStyle = row[4];
    ctx.fillText(String(row[3]), 900, y + 32);
    ctx.fillStyle = '#1c2740';
    ctx.beginPath();
    ctx.roundRect(1000, y + 16, 76, 26, 6);
    ctx.fill();
    ctx.fillStyle = '#93c5fd';
    ctx.font = '11px "Segoe UI", "Microsoft YaHei UI", sans-serif';
    ctx.fillText('启动', 1024, y + 33);
  });

  mirrorFrame = canvas.toDataURL('image/jpeg', 0.82).split(',')[1] ?? '';
  return mirrorFrame;
}

function mirrorCdpResult(method: string): Record<string, unknown> {
  if (method === 'Page.captureScreenshot') return { data: drawLauncherFrame() };
  if (method === 'Page.getLayoutMetrics') {
    return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } };
  }
  if (method === 'Runtime.evaluate') {
    return {
      result: {
        value: JSON.stringify({
          url: 'http://tauri.localhost/',
          title: '全部配置 – ShardBrowser',
          w: 1280,
          h: 800,
          dpr: 1,
        }),
      },
    };
  }
  return {};
}

const fakeHost = {
  storage: {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, String(value));
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  },
  serviceRequest: async (request: { path: string; body?: string }) => {
    const envelope = (data: unknown, status = 200) => ({ status, body: JSON.stringify(data) });
    const proxy = (data: unknown, status = 200) =>
      envelope({ status, body: JSON.stringify(data), truncated: false });
    if (request.path === '/workspace/state') return envelope({ state: workspaceState });
    if (request.path === '/workspace/server/status') return envelope(serverStatus);
    if (request.path === '/workspace/server/sync') return envelope(serverSync);
    if (request.path === '/workspace/server/control') return envelope(serverStatus);
    if (request.path.startsWith('/workspace/')) {
      const payload = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
      if (request.path === '/workspace/mapping') {
        const profileId = String(payload.profile_id ?? '');
        workspaceState.mappings = workspaceState.mappings.filter((item) => item.profile_id !== profileId);
        if (!payload.remove && profileId) {
          workspaceState.mappings.push({
            profile_id: profileId,
            profile_name: String(payload.profile_name ?? profileId),
            session_id: String(payload.session_id ?? 'preview-session'),
            source: 'panel',
            updated_at: Date.now(),
          });
        }
      }
      return envelope({ state: workspaceState });
    }
    if (request.path === '/launcher/status') {
      return envelope({
        found: true,
        cdpPort: 40326,
        targets: [
          {
            id: 'preview-launcher',
            title: '全部配置 – ShardBrowser',
            url: 'http://tauri.localhost/',
            webSocketDebuggerUrl: 'ws://preview.local/devtools/page/preview',
          },
        ],
        ports: [40326],
        injectedArguments: '--remote-debugging-port=40326 --remote-allow-origins=*',
      });
    }
    if (request.path === '/cdp/open') {
      mirrorEvents = [];
      return envelope({ sessionId: 'preview-cdp' });
    }
    if (request.path === '/cdp/send') {
      const payload = JSON.parse(request.body ?? '{}') as {
        message?: { id?: number; method?: string };
      };
      const message = payload.message ?? {};
      mirrorEvents.push({ id: message.id, result: mirrorCdpResult(String(message.method ?? '')) });
      return envelope({ sent: true });
    }
    if (request.path === '/cdp/events') {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const events = mirrorEvents.splice(0);
      return envelope({ events });
    }
    if (request.path === '/cdp/close') {
      mirrorEvents = [];
      return envelope({ closed: true });
    }
    if (request.path === '/shardx/discover') {
      return envelope({ found: true, running: true, port: 40325, token: 'preview.token', version: '2.1.4' });
    }
    if (request.path === '/proxy') {
      const req = JSON.parse(request.body ?? '{}') as { method: string; path: string };
      if (req.method === 'GET' && req.path === '/health') {
        return proxy({ ok: true, name: 'shardx-launcher', version: '2.1.4' });
      }
      if (req.method === 'GET' && req.path === '/profiles') return proxy({ profiles });
      if (req.method === 'GET' && req.path === '/proxies') return proxy({ proxies });
      return proxy({ error: 'preview: unhandled route' }, 404);
    }
    return envelope({ error: 'preview: unhandled route' }, 404);
  },
} as any;

const profiles: Profile[] = [
  { id: 'b7f1c2a4-1c8d-4f22-9d31-5f0a9e11c001', name: 'Google Ads 01', status: 'running', folder: 'Google', platform: 'Windows', proxy_id: 'px-1' },
  { id: 'b7f1c2a4-1c8d-4f22-9d31-5f0a9e11c002', name: 'Google Ads 02', status: 'stopped', folder: 'Google', platform: 'Windows', proxy_id: 'px-1' },
  { id: 'b7f1c2a4-1c8d-4f22-9d31-5f0a9e11c003', name: 'Gmail 养号 A', status: 'stopped', folder: 'Google', platform: 'macOS', proxy_id: 'px-2' },
  { id: 'b7f1c2a4-1c8d-4f22-9d31-5f0a9e11c004', name: 'Gmail 养号 B', status: 'running', folder: 'Google', platform: 'macOS', proxy_id: 'px-2' },
  { id: 'c9a2e7b1-2d9e-4a33-8e42-6a1b0f22d101', name: 'TikTok 矩阵 01', status: 'stopped', folder: '新账号', platform: 'Windows', proxy_id: 'px-3' },
  { id: 'c9a2e7b1-2d9e-4a33-8e42-6a1b0f22d102', name: 'TikTok 矩阵 02', status: 'stopped', folder: '新账号', platform: 'Windows', proxy_id: 'px-3' },
  { id: 'c9a2e7b1-2d9e-4a33-8e42-6a1b0f22d103', name: 'TikTok 矩阵 03', status: 'stopped', folder: '新账号', platform: 'Linux', proxy_id: 'px-3' },
  { id: 'd1e3f8c2-3e0f-4b44-9f53-7b2c1a33e201', name: 'Amazon 卖家', status: 'stopped', folder: '', platform: 'Windows', proxy_id: null },
  { id: 'd1e3f8c2-3e0f-4b44-9f53-7b2c1a33e202', name: 'eBay 小号', status: 'stopped', folder: '', platform: 'Windows', proxy_id: 'px-2' },
  { id: 'd1e3f8c2-3e0f-4b44-9f53-7b2c1a33e203', name: 'PayPal 备用', status: 'running', folder: '', platform: 'macOS', proxy_id: 'px-1' },
];

const proxies: Proxy[] = [
  { id: 'px-1', protocol: 'socks5', host: '127.0.0.1', port: 10808, country: 'US', status: 'ok' },
  { id: 'px-2', protocol: 'http', host: '10.0.0.21', port: 8080, country: 'JP', status: 'ok' },
  { id: 'px-3', protocol: 'socks5', host: '10.0.0.33', port: 1080, country: 'SG', status: 'ok' },
];

const targets: TargetInfo[] = [
  { targetId: 'TARGET-A', type: 'page', title: '登录 - Google 账号', url: 'https://accounts.google.com/signin' },
  { targetId: 'TARGET-B', type: 'page', title: '收件箱 - Gmail', url: 'https://mail.google.com/mail/u/0/#inbox' },
  { targetId: 'TARGET-C', type: 'page', title: '新标签页', url: 'about:blank' },
];

const nowStamp = Date.now();

const workspaceState = {
  version: 1,
  mappings: [
    { profile_id: profiles[0].id, profile_name: 'Google Ads 01', session_id: 'preview-session', source: 'panel', updated_at: nowStamp },
    { profile_id: profiles[4].id, profile_name: 'TikTok 矩阵 01', session_id: 'agent-session-2', source: 'mcp', updated_at: nowStamp },
    { profile_id: profiles[7].id, profile_name: 'Amazon 卖家', session_id: 'agent-session-3', source: 'mcp', updated_at: nowStamp },
  ],
  skills: [
    {
      id: 'skill-login',
      name: 'Google 账号登录',
      site: 'google.com',
      url_pattern: 'https://accounts.google.com/*',
      description: '打开登录页，填写邮箱并等待下一步。',
      steps: [
        { action: 'navigate', url: 'https://accounts.google.com/signin' },
        { action: 'wait', ms: 800 },
        { action: 'type', selector: 'input[type=email]', text: 'demo@example.com' },
        { action: 'extract', selector: 'body', mode: 'text' },
      ],
      created_at: nowStamp,
      updated_at: nowStamp,
    },
    {
      id: 'skill-export',
      name: 'Gmail 收件箱导出',
      site: 'mail.google.com',
      url_pattern: 'https://mail.google.com/*',
      description: '抓取收件箱标题列表并导出文本。',
      steps: [
        { action: 'navigate', url: 'https://mail.google.com/mail/u/0/#inbox' },
        { action: 'wait', selector: 'tr', ms: 1500 },
        { action: 'extract', selector: 'table', mode: 'text' },
      ],
      created_at: nowStamp,
      updated_at: nowStamp - 3600_000,
    },
    {
      id: 'skill-tiktok',
      name: 'TikTok 上传前检查',
      site: 'tiktok.com',
      url_pattern: 'https://www.tiktok.com/upload*',
      description: '检查上传页是否已登录。',
      steps: [
        { action: 'navigate', url: 'https://www.tiktok.com/upload' },
        { action: 'evaluate', script: 'document.cookie.includes("sessionid")' },
      ],
      created_at: nowStamp,
      updated_at: nowStamp - 7200_000,
    },
  ],
  assignments: [
    { skill_id: 'skill-login', target_type: 'folder', target_id: 'Google', created_at: nowStamp },
    { skill_id: 'skill-export', target_type: 'profile', target_id: profiles[0].id, created_at: nowStamp },
    { skill_id: 'skill-tiktok', target_type: 'folder', target_id: '新账号', created_at: nowStamp },
  ],
  settings: { launcher_path: 'D:\\Tools\\Auto-PC\\shardx\\ShardBrowser-Launcher-portable-win-x64.exe' },
};

const serverStatus = {
  found: true,
  running: true,
  version: '2.1.4',
  port: 40325,
  apiEnabled: true,
  dataRoot: 'D:\\Data\\shardx',
  settingsPath: 'C:\\Users\\24999\\AppData\\Roaming\\shardx-launcher\\settings.json',
  launcherPath: 'D:\\Tools\\Auto-PC\\shardx\\ShardBrowser-Launcher-portable-win-x64.exe',
  statePath: 'C:\\Users\\24999\\AppData\\Roaming\\shardx-workspace\\state.json',
  processes: [
    { pid: 24880, path: 'D:\\Tools\\Auto-PC\\shardx\\ShardBrowser-Launcher-portable-win-x64.exe' },
    { pid: 24912, path: 'D:\\Tools\\Auto-PC\\shardx\\chrome\\ShardBrowser.exe' },
  ],
};

const serverSync = {
  found: true,
  running: true,
  version: '2.1.4',
  port: 40325,
  dataRoot: 'D:\\Data\\shardx',
  syncedAt: Date.now(),
  profiles,
  profileCount: profiles.length,
  folders: [{ name: 'Google' }, { name: '新账号' }, { name: '未分类' }],
  folderCount: 3,
  proxies,
  proxyCount: proxies.length,
  running: profiles.filter((profile) => profile.status === 'running'),
  runningCount: profiles.filter((profile) => profile.status === 'running').length,
};

let fakeShot: string | null = null;

function pagePreview(): string {
  if (fakeShot) return fakeShot;
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1280, 800);
  ctx.fillStyle = '#f1f3f4';
  ctx.fillRect(0, 0, 1280, 64);
  ctx.fillStyle = '#1a73e8';
  ctx.font = '600 26px "Segoe UI", sans-serif';
  ctx.fillText('Google', 48, 42);
  ctx.fillStyle = '#3c4043';
  ctx.font = '500 18px "Segoe UI", sans-serif';
  ctx.fillText('Gmail', 240, 41);
  ctx.fillText('图片', 330, 41);
  ctx.fillStyle = '#202124';
  ctx.font = '600 32px "Segoe UI", sans-serif';
  ctx.fillText('登录', 470, 210);
  ctx.font = '16px "Segoe UI", sans-serif';
  ctx.fillText('使用您的 Google 账号继续前往 Gmail', 470, 248);
  ctx.strokeStyle = '#dadce0';
  ctx.lineWidth = 2;
  ctx.strokeRect(470, 300, 340, 54);
  ctx.strokeRect(470, 374, 340, 54);
  ctx.fillStyle = '#5f6368';
  ctx.font = '15px "Segoe UI", sans-serif';
  ctx.fillText('邮箱或电话号码', 486, 333);
  ctx.fillText('密码', 486, 407);
  ctx.fillStyle = '#1a73e8';
  ctx.fillRect(470, 460, 110, 40);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 15px "Segoe UI", sans-serif';
  ctx.fillText('下一步', 498, 486);
  fakeShot = canvas.toDataURL('image/jpeg', 0.82).split(',')[1] ?? null;
  return fakeShot ?? '';
}

const fakeCdp = {
  isOpen: () => true,
  send: async (method: string) => {
    if (method === 'Target.getTargets') return { targetInfos: targets };
    if (method === 'Target.attachToTarget') return { sessionId: 'CDPFAKE01' };
    if (method === 'Page.captureScreenshot') return { data: pagePreview() };
    if (method === 'Runtime.evaluate') {
      return {
        result: {
          value: JSON.stringify({
            url: 'https://accounts.google.com/signin',
            title: '登录 - Google 账号',
            w: 1280,
            h: 800,
            dpr: 1,
          }),
        },
      };
    }
    if (method === 'Page.getLayoutMetrics') {
      return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
    }
    return {};
  },
} as any;

transport.setHost(fakeHost);
const api = new ShardXApiClient(fakeHost);
const router = new SessionIsolationRouter();

const bootParams = new URLSearchParams(location.search);
try {
  const folderView = bootParams.get('folderView');
  if (folderView === 'cards' || folderView === 'list') window.localStorage.setItem('shardx-folder-view', folderView);
} catch {
  /* preview may run with storage disabled */
}

void (async () => {
  await api.init();
  await api.setToken('preview.token');
  const app = document.getElementById('app');
  if (!app) return;
  const ui = new ShardXTabWorkspaceUI(app, api, router, 'preview-session');
  void ui.refreshAll().then(
    () => console.log('[preview] refreshAll done', document.querySelectorAll('.prow').length, document.querySelectorAll('.profile-card').length),
    (error) => console.log('[preview] refreshAll failed', error),
  );

  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  const view = params.get('view');
  const tab = params.get('tab');
  const skillId = params.get('skill');
  window.setTimeout(() => {
    if (mode === 'cards' || mode === 'list' || mode === 'groups') {
      const seg = Array.from(document.querySelectorAll('.view-switch button')) as HTMLButtonElement[];
      const index = mode === 'cards' ? 0 : mode === 'list' ? 1 : 2;
      seg[index]?.click();
    }
    if (tab === 'mapping' || tab === 'skills' || tab === 'server') {
      (ui as any).activateTab(tab);
      if (tab === 'skills') {
        (ui as any).skillCreating = false;
        (ui as any).selectedSkillId = skillId || 'skill-login';
        (ui as any).renderSkills();
      }
    }
    if (view === 'instance' || view === 'instance2') {
      const picks = view === 'instance2' ? [profiles[0], profiles[1]] : [profiles[0]];
      for (const profile of picks) {
        const sandbox: SessionSandbox = router.bindSession('preview-session', profile.id, profile.name ?? '');
        router.attachCdp(profile.id, 'ws://127.0.0.1:40325/devtools/browser/preview', fakeCdp);
        const live = router.getByProfile(profile.id) ?? sandbox;
        (ui as any).openInstanceTab(live, profile);
      }
      const controller = (ui as any).controllers.get(`instance:${picks[0].id}`);
      if (controller) controller.drawer.classList.add('open');
    }
  }, 600);
})();
