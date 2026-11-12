import type { Ctx } from '../context';
import type { MetricSeries, Service } from '../types';
import {
  checkbox,
  clear,
  componentForType,
  el,
  errorMessage,
  fmtBytes,
  fmtNumber,
  iconButton,
  latestPoint,
  note,
  select,
  sparkline,
} from '../util';

function isBytes(name: string, unit?: string): boolean {
  return /bytes|_bytes$/i.test(name) || unit === 'bytes' || unit === 'B';
}

function display(last: number | null, name: string, unit?: string): { value: string; unit: string } {
  if (last === null) return { value: '—', unit: '' };
  if (isBytes(name, unit)) return { value: fmtBytes(last), unit: '' };
  if (unit === '%' || /pct|percent/i.test(name)) return { value: fmtNumber(last), unit: '%' };
  return { value: fmtNumber(last, 2), unit: unit ?? '' };
}

export function mountMetrics(host: HTMLElement, ctx: Ctx): () => void {
  let disposed = false;
  let timer = 0;
  let auto = false;
  let loading = false;
  let series: MetricSeries[] = [];
  const projectId = ctx.state.projectId;
  if (!projectId) return () => {};
  const container = el('div', { class: 'view' });
  host.appendChild(container);

  const services = ctx.state.services;
  const selected = (): Service | null => {
    const current = services.find((service) => service.id === ctx.state.serviceId);
    return current ?? services.find((service) => service.type === 'compute') ?? services[0] ?? null;
  };

  const toolbar = el('div', { class: 'toolbar' });
  const serviceSelect = select(
    services.length
      ? services.map((service) => ({ value: service.id, label: `${service.name} · ${service.type}` }))
      : [{ value: '', label: '暂无服务' }],
    selected()?.id,
  );
  const stepSelect = select(
    [
      { value: '60s', label: '粒度 1 分钟' },
      { value: '300s', label: '粒度 5 分钟' },
      { value: '900s', label: '粒度 15 分钟' },
    ],
    '60s',
  );
  const autoBox = checkbox('自动刷新（20 秒）', true);
  auto = true;
  const refresh = iconButton('refresh', { title: '刷新指标' });
  toolbar.append(serviceSelect, stepSelect, autoBox.wrap, el('div', { class: 'grow' }), refresh);
  const noteHost = el('div');
  const grid = el('div', { class: 'metric-grid' });
  container.append(toolbar, noteHost, grid);

  const metricCard = (
    label: string,
    name: string,
    unit: string | undefined,
    points: MetricSeries['points'],
    value: number | null,
    color: string,
  ): HTMLElement => {
    const shown = display(value, name, unit);
    return el(
      'div',
      { class: 'metric' },
      el('div', { class: 'metric-label', text: label }),
      el('div', { class: 'metric-value' }, shown.value, shown.unit ? el('small', { text: ` ${shown.unit}` }) : null),
      sparkline(points ?? [], color),
    );
  };

  const seriesFor = (name: string): MetricSeries[] => series.filter((item) => item.name === name);

  const aggregate = (name: string, mode: 'avg' | 'sum'): number | null => {
    const matches = seriesFor(name);
    const values = matches
      .map((item) => latestPoint(item.points))
      .filter((value): value is number => value !== null);
    if (!values.length) return null;
    const total = values.reduce((sum, value) => sum + value, 0);
    return mode === 'sum' ? total : total / values.length;
  };

  const pointsFor = (name: string): MetricSeries['points'] => {
    const matches = seriesFor(name);
    if (!matches.length) return [];
    return matches.reduce((best, item) =>
      (item.points?.length ?? 0) > (best.points?.length ?? 0) ? item : best,
    ).points;
  };

  const paint = (): void => {
    clear(grid);
    if (!series.length) {
      grid.appendChild(
        note('暂无指标数据。服务启动后通常需要 1–2 分钟才会产生第一个采样点。'),
      );
      return;
    }

    const handled = new Set<string>();
    const used = aggregate('memory_used_bytes', 'sum');
    const total = aggregate('memory_total_bytes', 'sum');
    if (seriesFor('cpu_pct').length) {
      handled.add('cpu_pct');
      grid.appendChild(
        metricCard(
          'CPU 使用率',
          'cpu_pct',
          '%',
          pointsFor('cpu_pct'),
          aggregate('cpu_pct', 'avg'),
          'var(--info)',
        ),
      );
    }
    if (seriesFor('cpu_cores').length) {
      handled.add('cpu_cores');
      grid.appendChild(
        metricCard(
          'CPU 核心（平均）',
          'cpu_cores',
          'core',
          pointsFor('cpu_cores'),
          aggregate('cpu_cores', 'avg'),
          'var(--warning)',
        ),
      );
    }
    if (seriesFor('memory_used_bytes').length) {
      handled.add('memory_used_bytes');
      handled.add('memory_total_bytes');
      const label =
        used !== null && total
          ? `内存用量（${Math.round((used / total) * 100)}% / ${fmtBytes(total)}）`
          : '内存用量';
      grid.appendChild(
        metricCard(
          label,
          'memory_used_bytes',
          undefined,
          pointsFor('memory_used_bytes'),
          used,
          'var(--success)',
        ),
      );
    }

    let others = 0;
    for (const item of series) {
      const name = item.name;
      if (handled.has(name)) continue;
      handled.add(name);
      const value = latestPoint(item.points);
      grid.appendChild(
        metricCard(name, name, item.unit, item.points, value, 'var(--primary)'),
      );
      others += 1;
      if (others >= 8) break;
    }
  };

  const load = async (quiet = false): Promise<void> => {
    const service = selected();
    if (!service || loading) return;
    loading = true;
    if (!quiet && !series.length) {
      clear(grid);
      for (let index = 0; index < 3; index += 1) {
        grid.appendChild(el('div', { class: 'skeleton', attrs: { style: 'height:92px' } }));
      }
    }
    try {
      const response = await ctx.api.metrics(projectId, {
        component: componentForType(service.type),
        group: service.name,
        branch: ctx.state.branch ?? undefined,
        step: stepSelect.value,
      });
      series = response.series ?? [];
      if (disposed) return;
      clear(noteHost);
      if (response.note) noteHost.appendChild(note(response.note, 'info'));
      paint();
    } catch (error) {
      if (disposed) return;
      clear(noteHost);
      noteHost.appendChild(note(errorMessage(error), 'error'));
    } finally {
      loading = false;
    }
  };

  serviceSelect.addEventListener('change', () => {
    ctx.selectService(serviceSelect.value || null);
    series = [];
    void load(false);
  });
  stepSelect.addEventListener('change', () => void load(false));
  refresh.addEventListener('click', () => void load(false));
  autoBox.input.addEventListener('change', () => {
    auto = autoBox.input.checked;
    window.clearInterval(timer);
    if (auto) timer = window.setInterval(() => {
      if (!document.hidden && !disposed) void load(true);
    }, 20000);
  });

  if (auto) {
    timer = window.setInterval(() => {
      if (!document.hidden && !disposed) void load(true);
    }, 20000);
  }

  void load(false);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    container.remove();
  };
}
