import type { Ctx } from '../context';
import type { LogLine, Service } from '../types';
import {
  checkbox,
  clear,
  componentForType,
  el,
  errorMessage,
  fmtTime,
  iconButton,
  note,
  select,
  toast,
} from '../util';

const ANSI = /\u001b\[[0-9;]*m/g;

function clean(message: string): string {
  return message.replace(ANSI, '');
}

export function mountLogs(host: HTMLElement, ctx: Ctx): () => void {
  let disposed = false;
  let timer = 0;
  let auto = false;
  let loading = false;
  let lines: LogLine[] = [];
  let noteText = '';
  const projectId = ctx.state.projectId;
  if (!projectId) return () => {};
  const container = el('div', { class: 'view' });
  host.appendChild(container);

  const services = ctx.state.services;
  const selected = (): Service | null => {
    const current = services.find((service) => service.id === ctx.state.serviceId);
    return current ?? services.find((service) => service.type === 'compute') ?? services[0] ?? null;
  };

  const toolbar = el('div', { class: 'log-toolbar' });
  const serviceSelect = select(
    services.length
      ? services.map((service) => ({ value: service.id, label: `${service.name} · ${service.type}` }))
      : [{ value: '', label: '暂无服务' }],
    selected()?.id,
  );
  const limitSelect = select(
    [
      { value: '100', label: '最近 100 行' },
      { value: '200', label: '最近 200 行' },
      { value: '500', label: '最近 500 行' },
      { value: '2000', label: '最近 2000 行' },
    ],
    '200',
  );
  const filterSelect = select(
    [
      { value: '', label: '全部级别' },
      { value: 'error', label: '仅错误' },
      { value: 'warn', label: '警告及以上' },
      { value: 'info', label: '信息及以上' },
    ],
    '',
  );
  const autoBox = checkbox('自动刷新');
  const refresh = iconButton('refresh', { title: '刷新日志' });
  const clearButton = iconButton('close', { title: '清空视图' });
  toolbar.append(
    serviceSelect,
    limitSelect,
    filterSelect,
    autoBox.wrap,
    el('div', { class: 'grow' }),
    clearButton,
    refresh,
  );
  const noteHost = el('div');
  const view = el('div', { class: 'log-view' });
  view.appendChild(el('div', { class: 'log-empty', text: '正在加载日志…' }));
  container.append(toolbar, noteHost, view);

  const passes = (level?: string): boolean => {
    const filter = filterSelect.value;
    if (!filter) return true;
    const value = (level ?? 'info').toLowerCase();
    if (filter === 'error') return value === 'error' || value === 'fatal';
    if (filter === 'warn') return value === 'error' || value === 'fatal' || value === 'warn' || value === 'warning';
    return true;
  };

  const paint = (): void => {
    const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    const previousScroll = view.scrollTop;
    clear(view);
    const filtered = lines.filter((line) => passes(line.level));
    if (!filtered.length) {
      view.appendChild(
        el('div', {
          class: 'log-empty',
          text: lines.length ? '当前筛选条件下没有日志。' : '暂无日志。服务启动并产生输出后会显示在这里。',
        }),
      );
      return;
    }
    for (const line of filtered) {
      const level = (line.level ?? 'info').toLowerCase();
      const prefix = [line.instance, line.region].filter(Boolean).join(' · ');
      view.appendChild(
        el(
          'div',
          { class: `log-line ${level}`.trim() },
          el('span', { class: 'log-time', text: fmtTime(line.ts) }),
          el('span', { class: 'log-level', text: line.level ?? 'info' }),
          el(
            'span',
            { class: 'log-msg' },
            prefix ? el('span', { class: 'log-prefix', text: `[${prefix}] ` }) : null,
            clean(line.message ?? ''),
          ),
        ),
      );
    }
    if (nearBottom) view.scrollTop = view.scrollHeight;
    else view.scrollTop = previousScroll;
  };

  const load = async (quiet = false): Promise<void> => {
    const service = selected();
    if (!service || loading) return;
    loading = true;
    if (!quiet && !lines.length) {
      clear(view);
      view.appendChild(el('div', { class: 'log-empty', text: '正在加载日志…' }));
    }
    try {
      const response = await ctx.api.logs(projectId, {
        component: componentForType(service.type),
        group: service.name,
        branch: ctx.state.branch ?? undefined,
        limit: Number(limitSelect.value),
      });
      lines = response.lines ?? [];
      noteText = response.note ?? '';
      if (disposed) return;
      clear(noteHost);
      if (noteText) noteHost.appendChild(note(noteText, 'info'));
      paint();
    } catch (error) {
      if (disposed) return;
      noteHost.replaceChildren(note(errorMessage(error), 'error'));
    } finally {
      loading = false;
    }
  };

  serviceSelect.addEventListener('change', () => {
    ctx.selectService(serviceSelect.value || null);
    lines = [];
    noteText = '';
    void load(false);
  });
  limitSelect.addEventListener('change', () => void load(false));
  filterSelect.addEventListener('change', () => paint());
  refresh.addEventListener('click', () => void load(false));
  clearButton.addEventListener('click', () => {
    lines = [];
    clear(view);
    view.appendChild(el('div', { class: 'log-empty', text: '视图已清空，下次刷新会重新拉取。' }));
    toast('已清空日志视图', 'neutral');
  });
  autoBox.input.addEventListener('change', () => {
    auto = autoBox.input.checked;
    if (auto) {
      timer = window.setInterval(() => {
        if (!document.hidden && !disposed) void load(true);
      }, 5000);
    } else {
      window.clearInterval(timer);
    }
  });

  view.addEventListener('scroll', () => {
    if (view.scrollHeight - view.scrollTop - view.clientHeight > 120) {
      auto = false;
      autoBox.input.checked = false;
      window.clearInterval(timer);
    }
  });

  void load(false);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    container.remove();
  };
}
