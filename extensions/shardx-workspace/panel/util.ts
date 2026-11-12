export type Child = Node | string | number | null | undefined | false | Child[];
export type ElProps = {
  class?: string; text?: string; html?: string; title?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
  props?: Record<string, unknown>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, opts: ElProps = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.html !== undefined) node.innerHTML = opts.html;
  if (opts.title !== undefined) node.title = opts.title;
  if (opts.attrs) {
    for (const [key, value] of Object.entries(opts.attrs)) {
      if (value === null || value === undefined || value === false) node.removeAttribute(key);
      else node.setAttribute(key, value === true ? '' : String(value));
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
    if (Array.isArray(child)) { append(parent, child); continue; }
    if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const ICONS: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
  play: '<path d="m7 4 13 8-13 8V4Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3.2-6.9L3 8"/><path d="M3 3v5h5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  logs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>',
  rocket: '<path d="M5 13c-1.6 1.6-2 5-2 5s3.4-.4 5-2"/><path d="M14 4c3.5.4 5.6 2.5 6 6l-8.5 8.5-5-5L14 4Z"/><circle cx="15" cy="9" r="1.4"/>',
  branch: '<path d="M6 3v12a3 3 0 0 0 3 3h6"/><circle cx="6" cy="18" r="2.4"/><circle cx="6" cy="4" r="2.4"/><circle cx="18" cy="18" r="2.4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  external: '<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  box: '<path d="m21 8-9-5-9 5v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v9"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 9.5H7Z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
  memory: '<rect x="3" y="6" width="18" height="11" rx="2"/><path d="M7 17v3M12 17v3M17 17v3M7 10h10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 8-8M16 7l2 2M19 4l2 2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>',
};

export function icon(name: string, size = 15): HTMLElement {
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

export function badge(label: string, tone: 'neutral' | 'success' | 'warning' | 'error' | 'info' = 'neutral', dot = false): HTMLElement {
  return el(
    'span',
    { class: `badge ${tone}` },
    dot ? el('span', { class: `dot ${tone === 'success' ? 'ok' : tone === 'warning' ? 'warn' : tone === 'error' ? 'err' : 'muted'}` }) : null,
    el('span', { text: label }),
  );
}

export function toast(message: string, tone: 'neutral' | 'success' | 'warning' | 'error' | 'info' = 'neutral', timeout = 4200): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${tone === 'neutral' ? '' : tone}`.trim(), text: message });
  host.appendChild(node);
  while (host.childElementCount > 4) host.removeChild(host.firstElementChild as Node);
  window.setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(3px)';
    node.style.transition = 'opacity .15s ease, transform .15s ease';
    window.setTimeout(() => node.remove(), 160);
  }, timeout);
}
