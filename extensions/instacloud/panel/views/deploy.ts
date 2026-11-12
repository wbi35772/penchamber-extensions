import type { Ctx } from '../context';
import type { Build, Service } from '../types';
import {
  badge,
  button,
  checkbox,
  clear,
  el,
  emptyState,
  errorMessage,
  field,
  fmtDateTime,
  icon,
  input,
  note,
  select,
  sleep,
  statusInfo,
  toast,
} from '../util';

export function mountDeploy(host: HTMLElement, ctx: Ctx): () => void {
  let disposed = false;
  const projectId = ctx.state.projectId;
  if (!projectId) return () => {};
  const container = el('div', { class: 'view' });
  host.appendChild(container);

  const computes = (): Service[] =>
    ctx.state.services.filter((service) => service.type === 'compute');

  const selected = (): Service | null => {
    const current = computes().find((service) => service.id === ctx.state.serviceId);
    return current ?? computes()[0] ?? null;
  };

  const draw = (): void => {
    if (disposed) return;
    clear(container);
    const services = computes();
    if (!services.length) {
      container.appendChild(
        emptyState({
          icon: 'rocket',
          title: '还没有 compute 服务',
          body: '先创建一个 compute 服务，再向它部署容器镜像或 GitHub 仓库。',
          action: button('去创建 compute', {
            class: 'btn primary',
            icon: 'plus',
            onClick: () => ctx.setTab('services'),
          }),
        }),
      );
      return;
    }

    const current = selected();
    const serviceSelect = select(
      services.map((service) => ({
        value: service.id,
        label: `${service.name}${service.branch_id ? ` · ${ctx.state.branches.find((b) => b.id === service.branch_id)?.name ?? ''}` : ''}`,
      })),
      current?.id,
    );
    serviceSelect.addEventListener('change', () => {
      ctx.selectService(serviceSelect.value);
      draw();
    });
    container.appendChild(
      el(
        'div',
        { class: 'toolbar' },
        el('span', { class: 'muted small', text: '部署目标' }),
        serviceSelect,
        el('div', { class: 'grow' }),
        el('span', { class: 'subtle tiny', text: ctx.state.branch ? `分支 ${ctx.state.branch}` : '' }),
      ),
    );

    const grid = el('div', { class: 'grid two' });
    grid.appendChild(imageCard(current));
    grid.appendChild(githubCard(current));
    container.appendChild(grid);
    container.appendChild(buildsCard(current));
    container.appendChild(
      note(
        '部署是异步的：提交后服务会重新拉取镜像并滚动更新。状态可在“服务”页查看，构建日志可在“日志”页选择 compute 组件查看。',
      ),
    );
  };

  const imageCard = (service: Service | null): HTMLElement => {
    const imageInput = input({ placeholder: 'ghcr.io/owner/app:latest' });
    const portInput = input({
      type: 'number',
      value: service?.port ? String(service.port) : '8080',
      min: 1,
      max: 65535,
    });
    const ws = checkbox('启用 WebSocket', Boolean(service?.websocket));
    const replace = checkbox('替换 GitHub 源（改用镜像）', false);
    const error = el('div', { class: 'form-error' });
    const submit = button('部署镜像', {
      class: 'btn primary',
      icon: 'rocket',
    });
    submit.addEventListener('click', () => {
      void (async () => {
        error.textContent = '';
        const image = imageInput.value.trim();
        if (!image) {
          error.textContent = '请填写镜像地址。';
          return;
        }
        submit.disabled = true;
        try {
          await ctx.api.deploy(projectId, {
            image,
            branch: ctx.state.branch ?? undefined,
            group: service?.name,
            port: portInput.value ? Number(portInput.value) : undefined,
            websocket: ws.input.checked,
            replaceSource: replace.input.checked || undefined,
          });
          toast('镜像部署已提交', 'success');
          submit.disabled = false;
          if (service) await refreshBuilds(service);
        } catch (errorValue) {
          error.textContent = errorMessage(errorValue);
          submit.disabled = false;
        }
      })();
    });

    return el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', { text: '部署 Docker 镜像' })),
      el(
        'div',
        { class: 'card-body form' },
        field('镜像地址', imageInput, '支持公开或私有仓库，只要集群可以拉取。', true),
        el(
          'div',
          { class: 'form-grid' },
          field('容器端口', portInput),
          el('div', { class: 'check-row' }, ws.wrap),
        ),
        el('div', { class: 'check-row' }, replace.wrap),
        error,
        el('div', { class: 'modal-actions' }, submit),
        el('div', {
          class: 'card-note',
          text: service
            ? `将部署到 ${service.name}${ctx.state.branch ? `（分支 ${ctx.state.branch}）` : ''}。`
            : '请选择部署目标。',
        }),
      ),
    );
  };

  const githubCard = (service: Service | null): HTMLElement => {
    const repoInput = input({ placeholder: 'owner/repo 或 https://github.com/owner/repo' });
    const branchInput = input({ placeholder: 'main（留空使用默认分支）' });
    const rootInput = input({ placeholder: '/ 或 apps/web' });
    const portInput = input({ type: 'number', value: '8080', min: 1, max: 65535 });
    const error = el('div', { class: 'form-error' });
    const submit = button('从 GitHub 部署', {
      class: 'btn primary',
      icon: 'branch',
    });
    submit.addEventListener('click', () => {
      void (async () => {
        error.textContent = '';
        const raw = repoInput.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
        const parts = raw.split('/').filter(Boolean);
        if (parts.length < 2) {
          error.textContent = '仓库格式应为 owner/repo。';
          return;
        }
        submit.disabled = true;
        try {
          await ctx.api.githubDeploy(projectId, {
            owner: parts[0],
            repo: parts[1],
            source: 'public',
            branch: branchInput.value.trim() || undefined,
            rootDir: rootInput.value.trim() || undefined,
            port: portInput.value ? Number(portInput.value) : undefined,
          });
          toast('GitHub 部署已提交，正在构建', 'success');
          submit.disabled = false;
          if (service) {
            await sleep(2500);
            await refreshBuilds(service);
          }
        } catch (errorValue) {
          error.textContent = errorMessage(errorValue);
          submit.disabled = false;
        }
      })();
    });

    return el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', { text: '从 GitHub 部署' })),
      el(
        'div',
        { class: 'card-body form' },
        field('仓库', repoInput, '仅支持公开仓库。私有仓库需要通过 GitHub App 安装后使用 insta CLI。', true),
        field('分支', branchInput),
        el(
          'div',
          { class: 'form-grid' },
          field('根目录', rootInput, '仓库包含多个应用时填写子目录。'),
          field('容器端口', portInput),
        ),
        error,
        el('div', { class: 'modal-actions' }, submit),
        el('div', {
          class: 'card-note',
          text: '构建由 InstaCloud 远程执行；推送新提交不会自动部署，除非项目已连接 GitHub App。',
        }),
      ),
    );
  };

  const buildsCard = (service: Service | null): HTMLElement => {
    const list = el('div', { class: 'build-list' }, el('div', { class: 'skeleton', attrs: { style: 'height:60px' } }));
    const rebuild = button('重新构建源', { class: 'btn small', icon: 'refresh' });
    rebuild.addEventListener('click', () => {
      if (!service) return;
      void (async () => {
        rebuild.disabled = true;
        try {
          await ctx.api.redeploySource(projectId, service.id);
          toast('已重新触发源构建', 'success');
          await sleep(2000);
          await refreshBuilds(service);
        } catch (error) {
          toast(errorMessage(error), 'error');
        } finally {
          rebuild.disabled = false;
        }
      })();
    });
    const card = el(
      'div',
      { class: 'card', attrs: { style: 'margin-top:11px' } },
      el(
        'div',
        { class: 'card-head' },
        el('h3', { text: '构建记录' }),
        el('div', { class: 'grow' }),
        rebuild,
      ),
      el('div', { class: 'card-body' }, list),
    );
    if (service) void loadBuilds(service, list);
    else list.textContent = '请选择 compute 服务。';
    return card;
  };

  const loadBuilds = async (service: Service, list: HTMLElement): Promise<void> => {
    try {
      const response = await ctx.api.builds(projectId, service.id, 8);
      if (disposed) return;
      const builds = response.builds ?? [];
      clear(list);
      if (!builds.length) {
        list.appendChild(
          note(
            service.source?.type === 'github'
              ? '还没有构建记录。可点击“重新构建源”触发一次。'
              : '此服务使用镜像部署，暂无 GitHub 构建记录。',
          ),
        );
        return;
      }
      const table = el('table', { class: 'table' });
      table.appendChild(
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: '状态' }),
            el('th', { text: '提交' }),
            el('th', { text: '来源' }),
            el('th', { text: '时间' }),
          ),
        ),
      );
      const body = el('tbody');
      for (const build of builds) {
        body.appendChild(buildRow(build));
      }
      table.appendChild(body);
      list.appendChild(el('div', { class: 'table-wrap' }, table));
    } catch (error) {
      if (disposed) return;
      clear(list);
      list.appendChild(el('div', { class: 'form-error', text: errorMessage(error) }));
    }
  };

  const refreshBuilds = async (service: Service): Promise<void> => {
    const cards = container.querySelectorAll('.card');
    const last = cards[cards.length - 1];
    const list = last?.querySelector('.build-list');
    if (list instanceof HTMLElement) await loadBuilds(service, list);
  };

  const buildRow = (build: Build): HTMLElement => {
    const status = statusInfo(build.status);
    const commit = build.sha || build.commit || build.ref || build.branch || '—';
    return el(
      'tr',
      {},
      el('td', {}, badge(status.label, status.tone, true)),
      el('td', { class: 'mono tiny', text: commit.length > 12 ? commit.slice(0, 12) : commit }),
      el('td', { class: 'small muted', text: build.source ?? '—' }),
      el(
        'td',
        { class: 'small muted', text: fmtDateTime(build.createdAt ?? build.created_at) },
      ),
    );
  };

  draw();
  return () => {
    disposed = true;
    container.remove();
  };
}
