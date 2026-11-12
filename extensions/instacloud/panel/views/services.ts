import type { Ctx } from '../context';
import type { Service } from '../types';
import {
  badge,
  button,
  checkbox,
  clear,
  confirmDialog,
  el,
  emptyState,
  errorMessage,
  field,
  icon,
  iconButton,
  input,
  note,
  openModal,
  select,
  statusInfo,
  toast,
  typeLabel,
} from '../util';

function typeIcon(type: string): string {
  if (type === 'compute') return 'server';
  if (type === 'storage') return 'box';
  if (type === 'redis') return 'cpu';
  return 'database';
}

function publicUrl(domain?: string | null): string | null {
  if (!domain) return null;
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

function serviceStatus(service: Service): string {
  return service.status || service.desired_state || '';
}

export function mountServices(host: HTMLElement, ctx: Ctx): () => void {
  let disposed = false;
  let timer = 0;
  let loading = false;
  let services: Service[] = [...ctx.state.services];
  const projectId = ctx.state.projectId;
  if (!projectId) return () => {};
  const container = el('div', { class: 'view' });
  host.appendChild(container);

  const branchName = (service: Service): string =>
    ctx.state.branches.find((branch) => branch.id === service.branch_id)?.name ?? '';

  const branchSummary = (service: Service): string => {
    const name = branchName(service);
    return name && ctx.state.branches.length > 1 ? ` · ${name}` : '';
  };

  const draw = (): void => {
    if (disposed) return;
    clear(container);
    const addButton = button('新建服务', {
      class: 'btn primary small',
      icon: 'plus',
      onClick: () => openCreate(),
    });
    const refreshButton = iconButton('refresh', {
      title: '刷新服务',
      onClick: () => void load(false),
    });
    container.appendChild(
      el(
        'div',
        { class: 'toolbar' },
        el('span', {
          class: 'grow muted small',
          text: services.length ? `${services.length} 个服务` : '暂无服务',
        }),
        refreshButton,
        addButton,
      ),
    );

    if (!services.length) {
      container.appendChild(
        emptyState({
          icon: 'server',
          title: '还没有服务',
          body: '创建 compute 后可以部署镜像或 GitHub 仓库；也可以直接添加 Postgres、Redis 等托管资源。',
          action: button('新建第一个服务', {
            class: 'btn primary',
            icon: 'plus',
            onClick: () => openCreate(),
          }),
        }),
      );
      return;
    }

    const grid = el('div', { class: 'service-grid' });
    for (const service of services) grid.appendChild(card(service));
    container.appendChild(grid);
    container.appendChild(
      note(
        '状态每 15 秒自动刷新。删除服务会同时删除其数据卷与路由，无法恢复。',
        'info',
      ),
    );
  };

  const runAction = async (
    service: Service,
    action: 'start' | 'stop' | 'restart' | 'suspend',
    control: HTMLButtonElement,
  ): Promise<void> => {
    const labels = { start: '启动', stop: '停止', restart: '重启', suspend: '暂停' };
    control.disabled = true;
    try {
      await ctx.api.serviceAction(projectId, service.id, action);
      toast(`${service.name}：已发送${labels[action]}请求`, 'success');
      await load(false);
      window.setTimeout(() => {
        void ctx.api
          .serviceState(projectId, service.id)
          .then((state) => {
            const next = state.state || state.desiredState;
            if (next) toast(`${service.name}：${next}`, statusInfo(next).tone);
          })
          .catch(() => undefined);
      }, 2200);
    } catch (error) {
      toast(errorMessage(error), 'error');
      control.disabled = false;
    }
  };

  const removeService = async (service: Service): Promise<void> => {
    const confirmed = await confirmDialog({
      title: `删除服务 ${service.name}`,
      message:
        '此操作会删除该服务、它的数据卷与公开路由，无法恢复。项目中的其他服务不受影响。',
      confirmLabel: '永久删除',
      danger: true,
      requireText: service.name,
    });
    if (!confirmed) return;
    try {
      await ctx.api.deleteService(projectId, service.id);
      toast(`已删除 ${service.name}`, 'success');
      await load(false);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const card = (service: Service): HTMLElement => {
    const status = statusInfo(serviceStatus(service));
    const url = publicUrl(service.domain);
    const meta = el('div', { class: 'service-meta' });
    const row = (key: string, value: string, mono = false): void => {
      meta.appendChild(el('span', { class: 'k', text: key }));
      meta.appendChild(el('span', { class: `v${mono ? ' mono' : ''}`.trim(), text: value }));
    };
    if (service.region) row('区域', service.region);
    if (service.image) row('镜像', service.image, true);
    if (service.port) row('端口', String(service.port));
    if (service.spec?.cpus || service.spec?.memory_mb) {
      row(
        '规格',
        `${service.spec.cpus ?? '?'} vCPU · ${service.spec.memory_mb ? `${service.spec.memory_mb} MB` : `${service.spec.cpu_kind ?? ''}`}`.trim(),
      );
    }
    if (service.volume_gib) row('磁盘', `${service.volume_gib} GiB`);
    if (url) row('域名', service.domain ?? '');

    const actions = el('div', { class: 'service-actions' });
    if (url) {
      actions.appendChild(
        button('打开', {
          class: 'btn ghost small',
          icon: 'external',
          onClick: () => void ctx.host.openUrl(url),
        }),
      );
    }
    if (service.type === 'compute') {
      actions.appendChild(
        iconButton('terminal', {
          title: '执行命令',
          onClick: () => {
            ctx.selectService(service.id);
            ctx.setTab('terminal');
          },
        }),
      );
    }
    actions.appendChild(
      iconButton('logs', {
        title: '查看日志',
        onClick: () => {
          ctx.selectService(service.id);
          ctx.setTab('logs');
        },
      }),
    );
    if (service.type === 'compute' || service.type === 'postgres') {
      actions.appendChild(
        iconButton('chart', {
          title: '查看指标',
          onClick: () => {
            ctx.selectService(service.id);
            ctx.setTab('metrics');
          },
        }),
      );
    }

    const running = ['running', 'active', 'ready', 'healthy', 'deployed', 'starting', 'provisioning'].includes(
      serviceStatus(service).toLowerCase(),
    );
    const power = iconButton(running ? 'stop' : 'play', {
      title: running ? '停止' : '启动',
    });
    power.addEventListener('click', () => {
      void runAction(service, running ? 'stop' : 'start', power);
    });
    actions.appendChild(power);
    const restart = iconButton('restart', { title: '重启' });
    restart.addEventListener('click', () => {
      void runAction(service, 'restart', restart);
    });
    actions.appendChild(restart);
    actions.appendChild(el('div', { class: 'grow' }));
    actions.appendChild(
      iconButton('trash', {
        title: '删除服务',
        class: 'danger',
        onClick: () => void removeService(service),
      }),
    );

    return el(
      'div',
      { class: 'service-card' },
      el(
        'div',
        { class: 'service-top' },
        el('div', { class: 'type-mark' }, icon(typeIcon(service.type), 14)),
        el(
          'div',
          { class: 'service-title' },
          el('div', { class: 'name', text: service.name }),
          el('div', {
            class: 'kind',
            text: `${typeLabel(service.type)}${service.always_on ? ' · 常开' : ''}${branchSummary(service)}`,
          }),
        ),
        badge(status.label, status.tone, true),
      ),
      meta,
      actions,
    );
  };

  const openCreate = (): void => {
    const typeSelect = select([
      { value: 'compute', label: 'Compute（运行容器）' },
      { value: 'postgres', label: 'Postgres' },
      { value: 'redis', label: 'Redis' },
      { value: 'mysql', label: 'MySQL' },
      { value: 'mongodb', label: 'MongoDB' },
      { value: 'storage', label: 'Storage（对象存储）' },
    ]);
    const nameInput = input({ placeholder: 'my-service' });
    const regionOptions = ctx.state.regions.length
      ? ctx.state.regions.map((region) => ({ value: region.slug, label: region.label || region.slug }))
      : [{ value: '', label: '默认区域' }];
    const regionSelect = select(regionOptions, ctx.state.settings['default-region'] || undefined);
    const imageInput = input({ placeholder: 'nginx:alpine' });
    const portInput = input({ type: 'number', value: '8080', min: 1, max: 65535 });
    const wsCheck = checkbox('启用 WebSocket');
    const alwaysCheck = checkbox('保持常开（always on）', true);
    const volumeInput = input({ type: 'number', value: '', placeholder: '例如 10', min: 0, step: 1 });
    const pgSelect = select(
      [
        { value: '', label: '默认版本' },
        { value: '16', label: 'PostgreSQL 16' },
        { value: '17', label: 'PostgreSQL 17' },
        { value: '18', label: 'PostgreSQL 18' },
      ],
    );
    const computeFields = el(
      'div',
      { class: 'form-grid' },
      field('镜像（可选）', imageInput, '留空则稍后在“部署”页推送镜像或 GitHub 仓库。'),
      field('端口', portInput, undefined),
      el('div', { class: 'check-row' }, wsCheck.wrap),
      el('div', { class: 'check-row' }, alwaysCheck.wrap),
    );
    const postgresField = field('Postgres 版本', pgSelect);
    const volumeField = field('磁盘大小（GiB）', volumeInput, '可选。数据库建议至少 10 GiB。');
    const errorBox = el('div', { class: 'form-error' });
    const body = el(
      'div',
      { class: 'form' },
      el(
        'div',
        { class: 'form-grid' },
        field('类型', typeSelect, undefined, true),
        field('名称', nameInput, '小写字母、数字和连字符。', true),
        field('区域', regionSelect),
      ),
      computeFields,
      postgresField,
      volumeField,
      errorBox,
      ctx.state.branch
        ? note(`服务将创建在分支 ${ctx.state.branch}。`)
        : null,
    );

    const updateFields = (): void => {
      const type = typeSelect.value;
      computeFields.style.display = type === 'compute' ? '' : 'none';
      postgresField.style.display = type === 'postgres' ? '' : 'none';
      volumeField.style.display = type === 'storage' || type === 'postgres' || type === 'mysql' || type === 'mongodb' ? '' : 'none';
      if (!nameInput.value || ['web', 'db', 'cache', 'files', 'mysql', 'mongo'].includes(nameInput.value)) {
        const suggestion: Record<string, string> = {
          compute: 'web',
          postgres: 'db',
          redis: 'cache',
          mysql: 'mysql',
          mongodb: 'mongo',
          storage: 'files',
        };
        nameInput.value = suggestion[type] ?? '';
      }
    };
    typeSelect.addEventListener('change', updateFields);
    updateFields();

    const cancel = button('取消', { class: 'btn' });
    const create = button('创建服务', { class: 'btn primary', icon: 'plus' });
    const modal = openModal({
      title: '新建服务',
      body,
      footer: el('div', { class: 'modal-actions' }, cancel, create),
    });
    cancel.addEventListener('click', () => modal.close());
    create.addEventListener('click', () => {
      void (async () => {
        errorBox.textContent = '';
        const type = typeSelect.value;
        const name = nameInput.value.trim();
        if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
          errorBox.textContent = '名称需为 1–41 位小写字母、数字或连字符，并以字母或数字开头。';
          return;
        }
        create.disabled = true;
        try {
          await ctx.api.createService(projectId, {
            type,
            name,
            branch: ctx.state.branch ?? undefined,
            region: regionSelect.value || undefined,
            image: type === 'compute' && imageInput.value.trim() ? imageInput.value.trim() : undefined,
            port: type === 'compute' && portInput.value ? Number(portInput.value) : undefined,
            websocket: type === 'compute' ? wsCheck.input.checked : undefined,
            alwaysOn: type === 'compute' ? alwaysCheck.input.checked : undefined,
            volumeGib: volumeInput.value ? Number(volumeInput.value) : undefined,
            pgVersion: type === 'postgres' && pgSelect.value ? pgSelect.value : undefined,
          });
          modal.close();
          toast(`已创建服务 ${name}`, 'success');
          await load(false);
        } catch (error) {
          errorBox.textContent = errorMessage(error);
          create.disabled = false;
        }
      })();
    });
  };

  const load = async (skeleton: boolean): Promise<void> => {
    if (loading) return;
    loading = true;
    if (skeleton) {
      clear(container);
      const grid = el('div', { class: 'service-grid' });
      for (let index = 0; index < 3; index += 1) {
        grid.appendChild(el('div', { class: 'skeleton', attrs: { style: 'height:132px' } }));
      }
      container.appendChild(grid);
    }
    try {
      const response = await ctx.api.services(projectId);
      services = response.services ?? [];
      ctx.state.services = services;
      if (!ctx.state.serviceId || !services.some((service) => service.id === ctx.state.serviceId)) {
        ctx.state.serviceId = services.find((service) => service.type === 'compute')?.id ?? services[0]?.id ?? null;
      }
      draw();
    } catch (error) {
      if (disposed) return;
      clear(container);
      container.appendChild(el('div', { class: 'error-box', text: errorMessage(error) }));
      container.appendChild(
        button('重试', { class: 'btn', icon: 'refresh', onClick: () => void load(true) }),
      );
    } finally {
      loading = false;
    }
  };

  timer = window.setInterval(() => {
    if (document.hidden || disposed || loading) return;
    void ctx.api
      .services(projectId)
      .then((response) => {
        const next = response.services ?? [];
        const changed =
          JSON.stringify(next.map((s) => [s.id, s.status, s.desired_state, s.domain, s.image])) !==
          JSON.stringify(services.map((s) => [s.id, s.status, s.desired_state, s.domain, s.image]));
        services = next;
        ctx.state.services = next;
        if (changed) draw();
      })
      .catch(() => undefined);
  }, 15000);

  void load(true);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    container.remove();
  };
}
