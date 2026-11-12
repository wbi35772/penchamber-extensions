import type { MetricPoint, Tone } from './types';

export type Child = Node | string | number | null | undefined | false | Child[];

export type ElProps = {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Partial<{
    [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void;
  }>;
  props?: Record<string, unknown>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.html !== undefined) node.innerHTML = opts.html;
  if (opts.title !== undefined) node.title = opts.title;
  if (opts.attrs) {
    for (const [key, value] of Object.entries(opts.attrs)) {
      if (value === null || value === undefined || value === false) {
        node.removeAttribute(key);
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  if (opts.on) {
    for (const [name, listener] of Object.entries(opts.on)) {
      if (listener) node.addEventListener(name, listener as EventListener);
    }
  }
  if (opts.props) Object.assign(node, opts.props);
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
      continue;
    }
    if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const ICONS: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
  play: '<path d="m7 4 13 8-13 8V4Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3.2-6.9L3 8"/><path d="M3 3v5h5"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  logs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>',
  rocket:
    '<path d="M5 13c-1.6 1.6-2 5-2 5s3.4-.4 5-2"/><path d="M14 4c3.5.4 5.6 2.5 6 6l-8.5 8.5-5-5L14 4Z"/><circle cx="15" cy="9" r="1.4"/>',
  branch:
    '<path d="M6 3v12a3 3 0 0 0 3 3h6"/><circle cx="6" cy="18" r="2.4"/><circle cx="6" cy="4" r="2.4"/><circle cx="18" cy="18" r="2.4"/>',
  server:
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  external:
    '<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  alert:
    '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  box: '<path d="m21 8-9-5-9 5v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v9"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 9.5H7Z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
  memory:
    '<rect x="3" y="6" width="18" height="11" rx="2"/><path d="M7 17v3M12 17v3M17 17v3M7 10h10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 8-8M16 7l2 2M19 4l2 2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>',
};

export function icon(name: keyof typeof ICONS | string, size = 15): HTMLElement {
  const paths = ICONS[name] ?? ICONS.info;
  return el('span', {
    class: 'ic',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`,
  });
}

export function button(
  label: string,
  opts: {
    class?: string;
    icon?: string;
    title?: string;
    disabled?: boolean;
    onClick?: (event: MouseEvent) => void;
  } = {},
): HTMLButtonElement {
  const node = el('button', {
    class: opts.class ?? 'btn',
    title: opts.title,
    props: { type: 'button', disabled: Boolean(opts.disabled) },
    on: opts.onClick ? { click: opts.onClick } : undefined,
  });
  if (opts.icon) node.appendChild(icon(opts.icon));
  node.appendChild(el('span', { text: label }));
  return node;
}

export function iconButton(
  name: string,
  opts: { title?: string; class?: string; disabled?: boolean; onClick?: () => void } = {},
): HTMLButtonElement {
  const node = el('button', {
    class: `icon-btn${opts.class ? ` ${opts.class}` : ''}`,
    title: opts.title,
    attrs: { 'aria-label': opts.title ?? name },
    props: { type: 'button', disabled: Boolean(opts.disabled) },
  });
  node.appendChild(icon(name, 15));
  if (opts.onClick) node.addEventListener('click', opts.onClick);
  return node;
}

export function field(
  label: string,
  control: HTMLElement,
  hint?: string,
  required = false,
): HTMLElement {
  return el(
    'div',
    { class: 'field' },
    el(
      'label',
      {},
      label,
      required ? el('span', { class: 'req', text: '*' }) : null,
    ),
    control,
    hint ? el('div', { class: 'hint', text: hint }) : null,
  );
}

export function input(attrs: {
  value?: string;
  placeholder?: string;
  type?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  class?: string;
}): HTMLInputElement {
  return el('input', {
    class: attrs.class ?? 'input',
    attrs: { type: attrs.type ?? 'text', placeholder: attrs.placeholder },
    props: {
      value: attrs.value ?? '',
      disabled: Boolean(attrs.disabled),
      min: attrs.min,
      max: attrs.max,
      step: attrs.step,
    },
  });
}

export function select(
  options: { value: string; label: string }[],
  value?: string,
): HTMLSelectElement {
  const node = el('select', { class: 'select' });
  for (const option of options) {
    node.appendChild(
      el('option', {
        text: option.label,
        attrs: { value: option.value },
        props: { selected: option.value === value },
      }),
    );
  }
  return node;
}

export function checkbox(label: string, checked = false): {
  wrap: HTMLElement;
  input: HTMLInputElement;
} {
  const box = el('input', { props: { type: 'checkbox', checked } });
  const wrap = el('label', { class: 'check' }, box, el('span', { text: label }));
  return { wrap, input: box };
}

export function badge(label: string, tone: Tone = 'neutral', dot = false): HTMLElement {
  return el(
    'span',
    { class: `badge ${tone}` },
    dot ? el('span', { class: `dot ${tone === 'neutral' ? 'muted' : tone === 'success' ? 'ok' : tone === 'warning' ? 'warn' : tone === 'error' ? 'err' : 'muted'}` }) : null,
    el('span', { text: label }),
  );
}

export function statusInfo(status?: string | null): { label: string; tone: Tone } {
  const value = (status ?? '').toLowerCase();
  if (['running', 'active', 'ready', 'healthy', 'deployed'].includes(value)) {
    return { label: status ?? 'running', tone: 'success' };
  }
  if (['starting', 'provisioning', 'deploying', 'building', 'restarting', 'pending', 'queued'].includes(value)) {
    return { label: status ?? 'starting', tone: 'warning' };
  }
  if (['stopped', 'suspended', 'idle', 'paused', 'inactive'].includes(value)) {
    return { label: status ?? 'stopped', tone: 'neutral' };
  }
  if (['error', 'failed', 'crashed', 'unhealthy'].includes(value)) {
    return { label: status ?? 'error', tone: 'error' };
  }
  return { label: status || '未知', tone: 'neutral' };
}

export function typeLabel(type: string): string {
  const map: Record<string, string> = {
    compute: 'Compute',
    postgres: 'Postgres',
    storage: 'Storage',
    redis: 'Redis',
    mysql: 'MySQL',
    mongodb: 'MongoDB',
  };
  return map[type] ?? type;
}

export function componentForType(type: string): string {
  if (type === 'compute') return 'compute';
  if (type === 'postgres') return 'db';
  return type;
}

export function fmtBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—';
  if (Math.abs(bytes) < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function fmtNumber(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 100) return value.toFixed(0);
  return value.toFixed(digits);
}

export function fmtTime(ts?: string | number | null): string {
  if (ts === undefined || ts === null || ts === '') return '—';
  const date = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  if (Number.isNaN(date.getTime())) return String(ts);
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function fmtDateTime(ts?: string | number | null): string {
  if (ts === undefined || ts === null || ts === '') return '—';
  const date = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  if (Number.isNaN(date.getTime())) return String(ts);
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function fmtRelative(ts?: string | null): string {
  if (!ts) return '—';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return '刚刚';
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

export function shortId(id?: string | null): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '未知错误';
}

let toastTimer = 0;

export function toast(message: string, tone: Tone = 'neutral', timeout = 4200): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${tone === 'neutral' ? '' : tone}`.trim(), text: message });
  host.appendChild(node);
  while (host.childElementCount > 4) host.removeChild(host.firstElementChild as Node);
  const id = window.setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(3px)';
    node.style.transition = 'opacity .15s ease, transform .15s ease';
    window.setTimeout(() => node.remove(), 160);
  }, timeout);
  toastTimer = id;
}

export function openModal(opts: {
  title: string;
  body: HTMLElement;
  footer?: HTMLElement;
  wide?: boolean;
  onClose?: () => void;
  closeOnBackdrop?: boolean;
}): { close: () => void; root: HTMLElement; modal: HTMLElement } {
  const previousFocus = document.activeElement as HTMLElement | null;
  let closed = false;
  const modal = el(
    'div',
    { class: `modal${opts.wide ? ' wide' : ''}`, attrs: { role: 'dialog', 'aria-modal': 'true' } },
    el(
      'div',
      { class: 'modal-head' },
      el('h2', { text: opts.title }),
      iconButton('close', {
        title: '关闭',
        onClick: () => close(),
      }),
    ),
    el('div', { class: 'modal-body' }, opts.body),
    opts.footer ? el('div', { class: 'modal-foot' }, opts.footer) : null,
  );
  const root = el('div', { class: 'modal-backdrop' }, modal);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    root.remove();
    opts.onClose?.();
    previousFocus?.focus?.();
  };
  root.addEventListener('mousedown', (event) => {
    if (event.target === root && opts.closeOnBackdrop !== false) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(root);
  const focusTarget = modal.querySelector<HTMLElement>(
    'input:not([type=hidden]), select, textarea, button',
  );
  focusTarget?.focus();
  return { close, root, modal };
}

export function confirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean, close: () => void) => {
      if (settled) return;
      settled = true;
      resolve(value);
      close();
    };
    const text = input({
      placeholder: opts.requireText ? `输入 ${opts.requireText} 以确认` : undefined,
    });
    const body = el(
      'div',
      { class: 'form' },
      el('div', { class: 'card-note', text: opts.message }),
      opts.requireText
        ? el(
            'div',
            { class: 'field' },
            el('label', { text: `请输入 “${opts.requireText}” 以确认` }),
            text,
          )
        : null,
    );
    const cancel = button('取消', { class: 'btn' });
    const ok = button(opts.confirmLabel ?? '确认', {
      class: `btn ${opts.danger ? 'danger' : 'primary'}`.trim(),
      disabled: Boolean(opts.requireText),
    });
    let close = () => {};
    const modal = openModal({
      title: opts.title,
      body,
      footer: el('div', { class: 'modal-actions' }, cancel, ok),
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
    close = modal.close;
    cancel.addEventListener('click', () => finish(false, close));
    ok.addEventListener('click', () => {
      if (opts.requireText && text.value.trim() !== opts.requireText) return;
      finish(true, close);
    });
    if (opts.requireText) {
      text.addEventListener('input', () => {
        ok.disabled = text.value.trim() !== opts.requireText;
      });
      text.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && text.value.trim() === opts.requireText) {
          event.preventDefault();
          finish(true, close);
        }
      });
    }
  });
}

export function promptDialog(opts: {
  title: string;
  label: string;
  placeholder?: string;
  value?: string;
  hint?: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null, close: () => void) => {
      if (settled) return;
      settled = true;
      resolve(value);
      close();
    };
    const text = input({ placeholder: opts.placeholder, value: opts.value });
    const error = el('div', { class: 'form-error' });
    const body = el(
      'div',
      { class: 'form' },
      field(opts.label, text, opts.hint, true),
      error,
    );
    const cancel = button('取消', { class: 'btn' });
    const ok = button(opts.confirmLabel ?? '确定', { class: 'btn primary' });
    let close = () => {};
    const modal = openModal({
      title: opts.title,
      body,
      footer: el('div', { class: 'modal-actions' }, cancel, ok),
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });
    close = modal.close;
    const submit = () => {
      const value = text.value.trim();
      if (!value) {
        error.textContent = '不能为空。';
        return;
      }
      const problem = opts.validate?.(value) ?? null;
      if (problem) {
        error.textContent = problem;
        return;
      }
      finish(value, close);
    };
    cancel.addEventListener('click', () => finish(null, close));
    ok.addEventListener('click', submit);
    text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  });
}

export function sparkline(points: MetricPoint[], color = 'var(--info)') {
  const width = 100;
  const height = 40;
  const values = points
    .map((point) => (Array.isArray(point) ? Number(point[1]) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '趋势');
  const grid = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  grid.setAttribute('class', 'gridline');
  grid.setAttribute('x1', '0');
  grid.setAttribute('x2', String(width));
  grid.setAttribute('y1', String(height - 1));
  grid.setAttribute('y2', String(height - 1));
  svg.appendChild(grid);
  if (!values.length) return svg;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const coords = values.map((value, index) => {
    const x = values.length > 1 ? index * step : width / 2;
    const y = height - 3 - ((value - min) / span) * (height - 7);
    return [x, y] as const;
  });
  const linePath = coords
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('class', 'area');
  area.setAttribute('d', `${linePath} L${width} ${height} L0 ${height} Z`);
  area.setAttribute('style', `fill:${color};opacity:.12`);
  svg.appendChild(area);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('class', 'line');
  line.setAttribute('d', linePath);
  line.setAttribute('style', `stroke:${color}`);
  svg.appendChild(line);
  return svg;
}

export function latestPoint(points?: MetricPoint[]): number | null {
  if (!points || !points.length) return null;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = Number(points[index]?.[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function note(text: string, tone: 'info' | 'warn' | 'error' = 'info'): HTMLElement {
  return el('div', {
    class: `note${tone === 'info' ? '' : ` ${tone}`}`.trim(),
    text,
  });
}

export function emptyState(opts: {
  icon?: string;
  title: string;
  body?: string;
  action?: HTMLElement;
}): HTMLElement {
  return el(
    'div',
    { class: 'empty' },
    opts.icon ? el('span', { class: 'big-icon' }, icon(opts.icon, 26)) : null,
    el('strong', { text: opts.title }),
    opts.body ? el('span', { text: opts.body }) : null,
    opts.action ?? null,
  );
}

export function copyToClipboard(text: string): void {
  if (!text) return;
  void navigator.clipboard?.writeText(text).catch(() => {
    const area = el('textarea', { props: { value: text } });
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } finally {
      area.remove();
    }
  });
}

export function setBusy(buttonNode: HTMLButtonElement, busy: boolean, label?: string): void {
  if (busy) {
    buttonNode.dataset.label = buttonNode.textContent ?? '';
    buttonNode.disabled = true;
    clear(buttonNode);
    buttonNode.appendChild(el('span', { class: 'spinner' }));
    buttonNode.appendChild(el('span', { text: label ?? '处理中…' }));
  } else {
    buttonNode.disabled = false;
    clear(buttonNode);
    if (label !== undefined) buttonNode.appendChild(el('span', { text: label }));
    else if (buttonNode.dataset.label) buttonNode.appendChild(el('span', { text: buttonNode.dataset.label }));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
