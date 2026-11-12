import type { Ctx } from '../context';
import type { Branch } from '../types';
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
  fmtRelative,
  iconButton,
  input,
  note,
  openModal,
  select,
  statusInfo,
  toast,
} from '../util';

export function mountBranches(host: HTMLElement, ctx: Ctx): () => void {
  let disposed = false;
  const projectId = ctx.state.projectId;
  if (!projectId) return () => {};
  const container = el('div', { class: 'view' });
  host.appendChild(container);
  let branches: Branch[] = [...ctx.state.branches];

  const draw = (): void => {
    if (disposed) return;
    clear(container);
    const defaultBranch = branches.find((branch) => branch.is_default);
    container.appendChild(
      el(
        'div',
        { class: 'toolbar' },
        el('span', {
          class: 'grow muted small',
          text: `${branches.length} 个分支${defaultBranch ? ` · 默认 ${defaultBranch.name}` : ''}`,
        }),
        iconButton('refresh', {
          title: '刷新分支',
          onClick: () => void load(false),
        }),
        button('新建分支', {
          class: 'btn primary small',
          icon: 'plus',
          onClick: () => openCreate(),
        }),
      ),
    );

    if (!branches.length) {
      container.appendChild(
        emptyState({
          icon: 'branch',
          title: '没有分支',
          body: '默认分支缺失，或当前项目尚未完成初始化。',
        }),
      );
      return;
    }

    const card = el('div', { class: 'card' });
    const body = el('div', { class: 'card-body', attrs: { style: 'padding:0' } });
    for (const branch of branches) body.appendChild(row(branch));
    card.appendChild(body);
    container.appendChild(card);
    container.appendChild(
      note(
        '分支拥有隔离的服务、密钥和环境变量。默认会复制当前分支的服务定义；创建时选择“空分支”可从零开始。删除分支会同时删除其全部服务。',
      ),
    );
  };

  const row = (branch: Branch): HTMLElement => {
    const status = statusInfo(branch.status);
    const count = ctx.state.services.filter((service) =>
      branch.is_default ? !service.branch_id || service.branch_id === branch.id : service.branch_id === branch.id,
    ).length;
    const isCurrent = ctx.state.branch === branch.name;
    const actions = el('div', { class: 'branch-actions' });
    if (isCurrent) {
      actions.appendChild(badge('当前分支', 'info'));
    } else {
      actions.appendChild(
        button('切换', {
          class: 'btn small',
          onClick: () => {
            ctx.state.branch = branch.name;
            ctx.render();
          },
        }),
      );
    }
    if (!branch.is_default) {
      actions.appendChild(
        iconButton('trash', {
          title: `删除分支 ${branch.name}`,
          class: 'danger',
          onClick: () => void remove(branch),
        }),
      );
    }
    return el(
      'div',
      { class: 'branch-row' },
      el('div', { class: 'name' }, branch.name),
      branch.is_default ? badge('默认', 'neutral') : null,
      el('span', { class: 'small muted', text: `${count} 个服务` }),
      el('span', { class: 'grow' }),
      status.label && branch.status ? badge(status.label, status.tone, true) : null,
      el('span', { class: 'tiny subtle', text: fmtRelative(branch.created_at) }),
      actions,
    );
  };

  const load = async (skeleton: boolean): Promise<void> => {
    if (disposed) return;
    if (skeleton) {
      clear(container);
      container.appendChild(el('div', { class: 'skeleton', attrs: { style: 'height:180px' } }));
    }
    try {
      const response = await ctx.api.branches(projectId);
      branches = response.branches ?? [];
      ctx.state.branches = branches;
      if (!ctx.state.branch) {
        ctx.state.branch = branches.find((branch) => branch.is_default)?.name ?? branches[0]?.name ?? null;
      }
      draw();
    } catch (error) {
      if (disposed) return;
      clear(container);
      container.appendChild(el('div', { class: 'error-box', text: errorMessage(error) }));
      container.appendChild(
        button('重试', { class: 'btn', icon: 'refresh', onClick: () => void load(true) }),
      );
    }
  };

  const openCreate = (): void => {
    const fromSelect = select(
      branches.map((branch) => ({
        value: branch.name,
        label: `${branch.name}${branch.is_default ? '（默认）' : ''}`,
      })),
      ctx.state.branch ?? branches.find((branch) => branch.is_default)?.name,
    );
    const nameInput = input({ placeholder: 'feature/my-change' });
    const empty = checkbox('创建空分支（不复制服务与环境变量）', false);
    const error = el('div', { class: 'form-error' });
    const body = el(
      'div',
      { class: 'form' },
      field('分支名称', nameInput, '支持字母、数字、连字符、下划线和斜杠。', true),
      field('基于分支', fromSelect),
      empty.wrap,
      error,
    );
    const cancel = button('取消', { class: 'btn' });
    const create = button('创建分支', { class: 'btn primary', icon: 'branch' });
    const modal = openModal({
      title: '新建分支',
      body,
      footer: el('div', { class: 'modal-actions' }, cancel, create),
    });
    cancel.addEventListener('click', () => modal.close());
    create.addEventListener('click', () => {
      void (async () => {
        error.textContent = '';
        const name = nameInput.value.trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,60}$/.test(name)) {
          error.textContent = '名称需为 1–61 位字母、数字、点、下划线、斜杠或连字符。';
          return;
        }
        if (branches.some((branch) => branch.name === name)) {
          error.textContent = `分支 ${name} 已存在。`;
          return;
        }
        create.disabled = true;
        try {
          await ctx.api.createBranch(projectId, {
            name,
            from: fromSelect.value || undefined,
            empty: empty.input.checked || undefined,
          });
          modal.close();
          toast(`已创建分支 ${name}`, 'success');
          ctx.state.branch = name;
          await ctx.refreshProject();
        } catch (errorValue) {
          error.textContent = errorMessage(errorValue);
          create.disabled = false;
        }
      })();
    });
  };

  const remove = async (branch: Branch): Promise<void> => {
    const confirmed = await confirmDialog({
      title: `删除分支 ${branch.name}`,
      message:
        '该分支上的服务、数据卷与环境变量都会删除，默认分支不受影响。此操作无法恢复。',
      confirmLabel: '永久删除分支',
      danger: true,
      requireText: branch.name,
    });
    if (!confirmed) return;
    try {
      await ctx.api.deleteBranch(projectId, branch.id);
      toast(`已删除分支 ${branch.name}`, 'success');
      if (ctx.state.branch === branch.name) ctx.state.branch = null;
      await ctx.refreshProject();
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  void load(true);
  return () => {
    disposed = true;
    container.remove();
  };
}
