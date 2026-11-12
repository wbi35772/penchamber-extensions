import { connectHost } from '@openchamber/sdk';
import type { HostClient, GuestConnection, HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { ShardXApiClient } from './api';
import { SessionIsolationRouter } from './router';
import { ShardXTabWorkspaceUI } from './ui';
import { transport } from './transport';

const host: HostClient = connectHost();
transport.setHost(host);
const apiClient = new ShardXApiClient(host);
const router = new SessionIsolationRouter();
let ui: ShardXTabWorkspaceUI | null = null;
let connection: GuestConnection | null = null;
let booting = false;

async function boot(defaultSessionId?: string): Promise<void> {
  if (ui) {
    if (defaultSessionId) ui.setSessionId(defaultSessionId);
    return;
  }
  if (booting) return;
  booting = true;
  const app = document.getElementById('app');
  if (!app) {
    booting = false;
    return;
  }

  await apiClient.init();
  ui = new ShardXTabWorkspaceUI(app, apiClient, router, defaultSessionId || 'default');

  // 自动探测 ShardX 本地 API（失败不阻塞界面）
  apiClient.connect().catch((error) => {
    console.warn('[ShardX] 自动连接失败:', error);
  });
}

host.onReady((ready: HostReadyContext) => {
  applyHostReady(ready, document.documentElement);
  connection = ready.connection;
  void boot(ready.session?.id);
});

host.onConnection((next: GuestConnection) => {
  connection = next;
  if (next.connected && !ui) void boot();
});

document.addEventListener('DOMContentLoaded', () => {
  if (!ui) void boot();
});
