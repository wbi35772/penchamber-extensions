import { CdpMultiplexer } from './cdp';
import type { ServiceTransport } from './transport';
import { el, button, iconButton, icon } from './util';

type LauncherTarget = {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
};

type LauncherStatus = {
  found: boolean;
  cdpPort: number | null;
  targets: LauncherTarget[];
  ports: number[];
  hint?: string;
  injectedArguments?: string;
};

export type LauncherMirrorCallbacks = {
  onLocalList: () => void;
};

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

function modifiersOf(event: MouseEvent | KeyboardEvent): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

function virtualKey(key: string): number {
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= 'A' && upper <= 'Z') return upper.charCodeAt(0);
    if (key >= '0' && key <= '9') return key.charCodeAt(0);
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Mirrors the ShardX launcher's own window (a Tauri WebView2 page) into the
 * extension panel. The launcher exposes its UI over the DevTools protocol when
 * it was started with a remote-debugging port; this class renders the frame
 * stream as an <img> and forwards mouse, wheel and keyboard input back.
 */
export class LauncherMirror {
  private root: HTMLElement;
  private image: HTMLImageElement;
  private keySink: HTMLTextAreaElement;
  private placeholder: HTMLElement;
  private placeholderTitle: HTMLElement;
  private placeholderText: HTMLElement;
  private statusDot: HTMLElement;
  private statusText: HTMLElement;
  private targetText: HTMLElement;
  private statusbar: HTMLElement;
  private restartBtn: HTMLButtonElement;
  private retryBtn: HTMLButtonElement;

  private cdp: CdpMultiplexer | null = null;
  private target: LauncherTarget | null = null;
  private viewport = { width: 1280, height: 800 };
  private frameTimer: number | null = null;
  private connecting: Promise<void> | null = null;
  private active = false;
  private busy = false;
  private failures = 0;
  private lastMove = 0;
  private disposed = false;
  private viewportEl!: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private appliedViewport = { width: 0, height: 0 };

  constructor(
    private host: HTMLElement,
    private transport: ServiceTransport,
    private callbacks: LauncherMirrorCallbacks,
  ) {
    this.root = el('div', { class: 'mirror-shell' });
    this.statusDot = el('span', { class: 'dot muted' });
    this.statusText = el('span', { class: 'mirror-status-text', text: '未连接' });
    this.targetText = el('span', { class: 'mirror-target', text: 'tauri.localhost' });
    this.image = el('img', {
      class: 'mirror-screen',
      attrs: { alt: 'ShardX 主界面镜像', draggable: 'false' },
    }) as HTMLImageElement;
    this.keySink = el('textarea', {
      class: 'mirror-key-sink',
      attrs: {
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: 'false',
        'aria-label': 'ShardX 键盘转发',
      },
    }) as HTMLTextAreaElement;
    this.placeholderTitle = el('h3', { text: '还没有连接 ShardX 主界面' });
    this.placeholderText = el('p', {
      text: '正在探测启动器的 WebView2 调试端口…',
    });
    this.placeholder = el(
      'div',
      { class: 'mirror-placeholder' },
      el('div', { class: 'mirror-icon' }, icon('globe', 26)),
      this.placeholderTitle,
      this.placeholderText,
    );
    const placeholderActions = el('div', { class: 'row-actions' });
    const restart = button('重启并启用镜像', {
      class: 'btn primary',
      icon: 'rocket',
      title: '带 WebView2 调试参数重启 ShardX；已有实例会被关闭',
      onClick: () => void this.restartLauncher(),
    });
    const retry = button('重试连接', {
      class: 'btn',
      icon: 'refresh',
      onClick: () => this.reconnect(),
    });
    const local = button('打开本地环境列表', {
      class: 'btn ghost',
      icon: 'logs',
      onClick: () => this.callbacks.onLocalList(),
    });
    placeholderActions.append(restart, retry, local);
    this.placeholder.appendChild(placeholderActions);
    this.restartBtn = restart;
    this.retryBtn = retry;

    this.statusbar = el('div', { class: 'mirror-statusbar' });

    const status = el('div', { class: 'mirror-status' }, this.statusDot, this.statusText);
    const toolbar = el(
      'div',
      { class: 'mirror-toolbar' },
      status,
      this.targetText,
      el('div', { class: 'spacer' }),
      this.retryBtn.cloneNode(true) as HTMLButtonElement,
      this.restartBtn.cloneNode(true) as HTMLButtonElement,
    );
    const toolbarRetry = toolbar.querySelectorAll('.btn')[0] as HTMLButtonElement | undefined;
    const toolbarRestart = toolbar.querySelectorAll('.btn')[1] as HTMLButtonElement | undefined;
    toolbarRetry?.addEventListener('click', () => this.reconnect());
    toolbarRestart?.addEventListener('click', () => void this.restartLauncher());

    const viewport = el('div', { class: 'mirror-viewport' }, this.image, this.keySink, this.placeholder);
    this.viewportEl = viewport;
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.queueResize());
      this.resizeObserver.observe(viewport);
    }
    this.root.append(toolbar, viewport, this.statusbar);
    this.host.appendChild(this.root);

    this.bindInput(viewport);
    this.setStatus('未连接', 'muted');
    this.renderStatusbar('');
  }

  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    if (active) {
      void this.ensureConnected();
      this.schedule(120);
    } else if (this.frameTimer !== null) {
      window.clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    if (this.frameTimer !== null) window.clearTimeout(this.frameTimer);
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.frameTimer = null;
    this.resizeTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.closeCdp();
    this.root.remove();
  }

  private setStatus(text: string, tone: 'ok' | 'warn' | 'muted' | 'error'): void {
    this.statusText.textContent = text;
    this.statusDot.className = `dot ${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'error' ? 'err' : 'muted'}`;
    this.retryBtn.disabled = this.busy;
    this.restartBtn.disabled = this.busy;
    const toolbarButtons = this.root.querySelectorAll('.mirror-toolbar .btn');
    for (const node of toolbarButtons) (node as HTMLButtonElement).disabled = this.busy;
  }

  private renderStatusbar(extra: string): void {
    this.statusbar.replaceChildren(
      el('span', { text: this.target ? `${this.target.title || 'ShardX'} · ${this.target.url}` : 'ShardX 主界面 · tauri.localhost' }),
      el('span', { class: 'spacer' }),
      el('span', {
        text: this.cdp?.isOpen()
          ? `镜像 ${this.viewport.width}×${this.viewport.height}${extra ? ` · ${extra}` : ''} · 点击画面接管键盘`
          : '未连接',
      }),
    );
  }

  private showPlaceholder(text: string): void {
    this.root.classList.remove('live');
    this.image.removeAttribute('src');
    this.placeholder.hidden = false;
    this.placeholderTitle.textContent = '还没有连接 ShardX 主界面';
    this.placeholderText.textContent =
      text ||
      '启动器没有开放 WebView2 调试端口。点「重启并启用镜像」让扩展带调试参数重新拉起 ShardX。';
    this.setStatus('未连接', 'warn');
    this.targetText.textContent = 'tauri.localhost';
    this.renderStatusbar('');
  }

  private fail(message: string, keepPlaceholder: boolean): void {
    console.warn('[ShardX] launcher mirror', message);
    this.root.classList.remove('live');
    this.image.removeAttribute('src');
    this.placeholder.hidden = false;
    this.placeholderTitle.textContent = '镜像未连接';
    this.placeholderText.textContent = message;
    this.setStatus('镜像断开', 'error');
    this.renderStatusbar('');
    if (!keepPlaceholder) this.statusbar.replaceChildren(el('span', { text: message }));
  }

  private reconnect(): void {
    if (this.disposed) return;
    this.closeCdp();
    this.failures = 0;
    this.placeholder.hidden = false;
    this.setStatus('正在重连…', 'warn');
    void this.ensureConnected();
  }

  private ensureConnected(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.cdp?.isOpen()) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.setStatus('正在探测 ShardX 镜像…', 'warn');
      try {
        const status = await this.transport.call<LauncherStatus>('/launcher/status', {});
        if (this.disposed || !this.active) return;
        const target = status.targets.find((item) => item.webSocketDebuggerUrl) ?? null;
        if (!status.found || !target) {
          this.showPlaceholder(status.hint ?? '');
          return;
        }
        await this.connect(target, status.cdpPort);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.fail(`镜像连接失败：${message}`, true);
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private async connect(target: LauncherTarget, cdpPort: number | null): Promise<void> {
    this.closeCdp();
    const cdp = new CdpMultiplexer('launcher-mirror');
    this.cdp = cdp;
    this.setStatus('正在连接镜像…', 'warn');
    try {
      await cdp.connect(target.webSocketDebuggerUrl, 15000);
      await cdp.send('Page.enable', {}, null, 8000);
      this.viewport = (await this.desiredViewport()) ?? (await this.measure(cdp));
      this.appliedViewport = { width: 0, height: 0 };
      await this.applyViewport(cdp, true);
      this.target = target;
      this.failures = 0;
      this.root.classList.add('live');
      this.placeholder.hidden = true;
      this.setStatus('镜像中', 'ok');
      this.targetText.textContent = `${target.title || 'ShardX'} · ${cdpPort ? `调试端口 ${cdpPort}` : 'CDP'}`;
      this.renderStatusbar('');
      this.schedule(100);
    } catch (error) {
      this.closeCdp();
      throw error;
    }
  }

  /** Size the launcher page to the panel area so the mirror fills it edge to edge. */
  private async desiredViewport(): Promise<{ width: number; height: number } | null> {
    const rect = this.viewportEl.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 100) return null;
    return {
      width: Math.max(320, Math.min(1920, Math.round(rect.width))),
      height: Math.max(240, Math.min(1200, Math.round(rect.height))),
    };
  }

  private queueResize(): void {
    if (this.disposed) return;
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      void this.applyViewport(this.cdp, true);
    }, 160);
  }

  private async applyViewport(cdp: CdpMultiplexer | null, force = false): Promise<void> {
    if (!cdp?.isOpen()) return;
    const size = await this.desiredViewport();
    if (!size) return;
    if (
      !force &&
      size.width === this.appliedViewport.width &&
      size.height === this.appliedViewport.height
    ) {
      return;
    }
    try {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: size.width,
          height: size.height,
          deviceScaleFactor: 1,
          mobile: false,
          screenWidth: size.width,
          screenHeight: size.height,
        },
        null,
        6000,
      );
      this.viewport = size;
      this.appliedViewport = size;
      this.renderStatusbar('');
      this.schedule(60);
    } catch (error) {
      console.warn('[ShardX] launcher mirror resize', error);
    }
  }

  private async measure(cdp: CdpMultiplexer): Promise<{ width: number; height: number }> {
    try {
      const metrics = await cdp.send<{
        cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
      }>('Page.getLayoutMetrics', {}, null, 6000);
      const width = Math.round(Number(metrics.cssLayoutViewport?.clientWidth) || 1280);
      const height = Math.round(Number(metrics.cssLayoutViewport?.clientHeight) || 800);
      return {
        width: Math.max(320, Math.min(4096, width)),
        height: Math.max(240, Math.min(4096, height)),
      };
    } catch {
      return { width: 1280, height: 800 };
    }
  }

  private closeCdp(): void {
    const cdp = this.cdp;
    this.cdp = null;
    this.target = null;
    try {
      cdp?.close();
    } catch {
      /* socket already closed */
    }
  }

  private schedule(delay: number): void {
    if (this.frameTimer !== null) window.clearTimeout(this.frameTimer);
    this.frameTimer = window.setTimeout(() => {
      this.frameTimer = null;
      void this.frame();
    }, delay);
  }

  private async frame(): Promise<void> {
    if (this.disposed || !this.active) return;
    const cdp = this.cdp;
    if (!cdp || !cdp.isOpen()) {
      this.schedule(900);
      void this.ensureConnected();
      return;
    }
    if (this.busy) {
      this.schedule(200);
      return;
    }
    this.busy = true;
    try {
      const shot = await cdp.send<{ data?: string }>(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 72, captureBeyondViewport: false },
        null,
        8000,
      );
      if (shot?.data && this.active) {
        this.image.src = `data:image/jpeg;base64,${shot.data}`;
        this.root.classList.add('live');
        this.placeholder.hidden = true;
        this.failures = 0;
        this.setStatus('镜像中', 'ok');
      }
      this.schedule(900);
    } catch (error) {
      this.failures += 1;
      if (this.failures >= 3) {
        const message = error instanceof Error ? error.message : String(error);
        this.fail(`镜像画面中断：${message}`, true);
        this.closeCdp();
        this.schedule(1500);
        void this.ensureConnected();
        return;
      }
      this.schedule(450);
    } finally {
      this.busy = false;
    }
  }

  private async restartLauncher(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    this.setStatus('正在重启 ShardX…', 'warn');
    this.placeholder.hidden = false;
    this.placeholderTitle.textContent = '正在启用镜像';
    this.placeholderText.textContent =
      '正在带 WebView2 调试参数重启 ShardX 启动器；已运行的指纹实例会被关闭，请稍候…';
    try {
      this.closeCdp();
      await this.transport.call('/workspace/server/control', { action: 'restart' });
      this.setStatus('等待调试端口…', 'warn');
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline && !this.disposed) {
        const status = await this.transport.call<LauncherStatus>('/launcher/status', {});
        const target = status.targets.find((item) => item.webSocketDebuggerUrl) ?? null;
        if (target) {
          await this.connect(target, status.cdpPort);
          return;
        }
        await sleep(1500);
      }
      throw new Error('45 秒内没有等到 WebView2 调试端口');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(`启用镜像失败：${message}`, true);
    } finally {
      this.busy = false;
      this.setStatus(this.cdp?.isOpen() ? '镜像中' : '未连接', this.cdp?.isOpen() ? 'ok' : 'warn');
    }
  }

  private mapPoint(event: MouseEvent): { x: number; y: number } | null {
    const rect = this.image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / this.viewport.width, rect.height / this.viewport.height);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const drawWidth = this.viewport.width * scale;
    const drawHeight = this.viewport.height * scale;
    const left = rect.left + (rect.width - drawWidth) / 2;
    const top = rect.top + (rect.height - drawHeight) / 2;
    const x = (event.clientX - left) / scale;
    const y = (event.clientY - top) / scale;
    if (x < 0 || y < 0 || x > this.viewport.width || y > this.viewport.height) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  private sendMouse(
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    event: MouseEvent,
    button: 'left' | 'right' | 'none' = 'left',
    buttons = type === 'mousePressed' ? 1 : 0,
  ): void {
    const cdp = this.cdp;
    if (!cdp?.isOpen()) return;
    const point = this.mapPoint(event);
    if (!point) return;
    void cdp
      .send(
        'Input.dispatchMouseEvent',
        {
          type,
          x: point.x,
          y: point.y,
          button,
          buttons,
          clickCount: type === 'mouseMoved' ? 0 : 1,
          modifiers: modifiersOf(event),
        },
        null,
        5000,
      )
      .catch(() => null);
  }

  private wheel(event: WheelEvent): void {
    const cdp = this.cdp;
    if (!cdp?.isOpen()) return;
    const point = this.mapPoint(event);
    if (!point) return;
    void cdp
      .send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseWheel',
          x: point.x,
          y: point.y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers: modifiersOf(event),
        },
        null,
        5000,
      )
      .catch(() => null);
  }

  private bindInput(viewport: HTMLElement): void {
    const focusSink = () => {
      try {
        this.keySink.focus({ preventScroll: true });
      } catch {
        this.keySink.focus();
      }
    };

    viewport.addEventListener('mousedown', (event) => {
      if (event.button === 2) return;
      focusSink();
      this.sendMouse('mousePressed', event, 'left', 1);
    });
    viewport.addEventListener('mouseup', (event) => {
      if (event.button === 2) return;
      this.sendMouse('mouseReleased', event, 'left', 0);
    });
    viewport.addEventListener('mousemove', (event) => {
      const now = Date.now();
      if (now - this.lastMove < 160) return;
      this.lastMove = now;
      this.sendMouse('mouseMoved', event, 'none', 0);
    });
    viewport.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.wheel(event);
      },
      { passive: false },
    );
    viewport.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      focusSink();
      this.sendMouse('mousePressed', event, 'right', 2);
      this.sendMouse('mouseReleased', event, 'right', 0);
    });
    viewport.addEventListener('dragstart', (event) => event.preventDefault());

    this.keySink.addEventListener('keydown', (event) => void this.forwardKey(event));
    this.keySink.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text');
      if (!text) return;
      event.preventDefault();
      this.insertText(text);
    });
    this.keySink.addEventListener('compositionend', (event) => {
      if (event.data) this.insertText(event.data);
      this.keySink.value = '';
    });
    this.keySink.addEventListener('input', () => {
      const text = this.keySink.value;
      this.keySink.value = '';
      if (text) this.insertText(text);
    });
  }

  private async forwardKey(event: KeyboardEvent): Promise<void> {
    const cdp = this.cdp;
    if (!cdp?.isOpen()) return;
    const named = KEY_SPECS[event.key];
    const hasCommand = event.ctrlKey || event.metaKey || event.altKey;

    if (!named && !hasCommand && event.key.length === 1) {
      event.preventDefault();
      await cdp.send('Input.insertText', { text: event.key }, null, 5000).catch(() => null);
      return;
    }
    if (!named && !hasCommand) return;

    event.preventDefault();
    const keyCode = named?.keyCode ?? virtualKey(event.key);
    const params: Record<string, unknown> = {
      key: event.key,
      code: named?.code ?? event.code,
      modifiers: modifiersOf(event),
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    };
    if (named?.text && !hasCommand) {
      params.text = named.text;
      params.unmodifiedText = named.text;
    }
    const type = named?.text && !hasCommand ? 'keyDown' : 'rawKeyDown';
    await cdp.send('Input.dispatchKeyEvent', { type, ...params }, null, 5000).catch(() => null);
    delete params.text;
    delete params.unmodifiedText;
    await cdp
      .send('Input.dispatchKeyEvent', { type: 'keyUp', ...params }, null, 5000)
      .catch(() => null);
  }

  private insertText(text: string): void {
    const cdp = this.cdp;
    if (!cdp?.isOpen() || !text) return;
    void cdp.send('Input.insertText', { text }, null, 5000).catch(() => null);
  }
}
