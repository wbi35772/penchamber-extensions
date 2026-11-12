import type { Ctx } from '../context';
import type { Service, TermLine, TermState } from '../types';
import {
  button,
  clear,
  el,
  emptyState,
  errorMessage,
  iconButton,
  note,
  select,
  toast,
} from '../util';

const ANSI = /\u001b\[[0-9;]*m/g;

function clean(text: string): string {
  return text.replace(ANSI, '');
}

function linesOf(text: string | undefined, kind: 'out' | 'err'): TermLine[] {
  if (!text) return [];
  const trimmed = clean(text).replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (!trimmed) return [];
  return trimmed.split('\n').map((line) => ({ kind, text: line }));
}

export function mountTerminal(host: HTMLElement, ctx: Ctx): () => void {
  let disposed = false;
  let running = false;
  const projectId = ctx.state.projectId;
  if (!projectId) return () => {};
  const container = el('div', { class: 'view' });
  host.appendChild(container);

  const computes = ctx.state.services.filter((service) => service.type === 'compute');
  if (!computes.length) {
    container.appendChild(
      emptyState({
        icon: 'terminal',
        title: '没有可执行命令的服务',
        body: '只有 compute 服务支持远程执行。先创建一个 compute 服务并完成部署。',
        action: button('去服务页', {
          class: 'btn primary',
          onClick: () => ctx.setTab('services'),
        }),
      }),
    );
    return () => container.remove();
  }

  const current = (): Service => {
    const selected = computes.find((service) => service.id === ctx.state.serviceId);
    return selected ?? computes[0];
  };

  const termState = (serviceId: string): TermState => {
    const existing = ctx.state.term[serviceId];
    if (existing) return existing;
    const created: TermState = { lines: [], history: [], draft: '', cursor: 0 };
    ctx.state.term[serviceId] = created;
    return created;
  };

  let service = current();
  let term = termState(service.id);

  const serviceSelect = select(
    computes.map((item) => ({ value: item.id, label: item.name })),
    service.id,
  );
  serviceSelect.addEventListener('change', () => {
    ctx.selectService(serviceSelect.value);
    ctx.render();
  });

  const head = el(
    'div',
    { class: 'term-head' },
    el('span', { class: 'small muted', text: '目标' }),
    serviceSelect,
    el('span', { class: 'grow' }),
    iconButton('copy', {
      title: '复制输出',
      onClick: () => {
        const text = term.lines
          .map((line) => `${line.kind === 'cmd' ? '$ ' : line.kind === 'err' ? '! ' : line.kind === 'meta' ? '· ' : ''}${line.text}`)
          .join('\n');
        ctx.copy(text);
        toast('输出已复制', 'success');
      },
    }),
    iconButton('trash', {
      title: '清空输出',
      onClick: () => {
        term.lines = [];
        paint();
      },
    }),
  );

  const output = el('div', { class: 'term-output' });
  const prompt = el('span', { class: 'term-prompt', text: '$' });
  const commandInput = el('input', {
    class: 'term-input',
    attrs: { placeholder: '输入命令，例如 ls -la', spellcheck: 'false', autocomplete: 'off' },
    props: { value: term.draft },
  });
  const runButton = button('运行', { class: 'btn primary small', icon: 'play' });
  const inputRow = el('div', { class: 'term-input-row' }, prompt, commandInput, runButton);
  const chips = el('div', { class: 'term-chips' });
  for (const command of ['ls -la', 'pwd', 'id', 'ps aux | head -20', 'df -h', 'env | sort | head -40']) {
    chips.appendChild(
      el('button', {
        class: 'term-chip',
        text: command,
        attrs: { type: 'button' },
        on: {
          click: () => {
            commandInput.value = command;
            commandInput.focus();
          },
        },
      }),
    );
  }

  const card = el(
    'div',
    { class: 'terminal-card' },
    head,
    output,
    inputRow,
    chips,
  );
  container.append(card);
  container.appendChild(
    note(
      '每次执行都是一次性命令（sh -lc），不提供交互式 PTY，单次最长 15 秒；交互式 SSH 需要人工登录会话，API 令牌无法使用。',
      'warn',
    ),
  );

  const paint = (): void => {
    clear(output);
    if (!term.lines.length) {
      output.appendChild(
        el('div', { class: 'term-line meta', text: '连接就绪。输入命令后按 Enter 运行。' }),
      );
      return;
    }
    for (const line of term.lines) {
      output.appendChild(
        el('div', { class: `term-line ${line.kind}`.trim(), text: line.text }),
      );
    }
    output.scrollTop = output.scrollHeight;
  };

  const append = (newLines: TermLine[]): void => {
    for (const line of newLines) term.lines.push(line);
    if (term.lines.length > 2000) term.lines = term.lines.slice(-2000);
  };

  const run = async (): Promise<void> => {
    if (running) return;
    const command = commandInput.value.trim();
    if (!command) return;
    running = true;
    runButton.disabled = true;
    commandInput.disabled = true;
    append([{ kind: 'cmd', text: command, time: Date.now() }]);
    term.history.push(command);
    if (term.history.length > 60) term.history = term.history.slice(-60);
    term.cursor = term.history.length;
    term.draft = '';
    commandInput.value = '';
    paint();
    const started = Date.now();
    try {
      const result = await ctx.api.exec(projectId, service.id, ['sh', '-lc', command], 15);
      append(linesOf(result.stdout, 'out'));
      append(linesOf(result.stderr, 'err'));
      const duration = Date.now() - started;
      const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 0;
      append([
        {
          kind: 'meta',
          text: `exit ${exitCode} · ${duration} ms${exitCode === 0 ? '' : ' · 命令返回非零状态'}`,
        },
      ]);
    } catch (error) {
      append([{ kind: 'err', text: errorMessage(error) }]);
    } finally {
      running = false;
      runButton.disabled = false;
      commandInput.disabled = false;
      paint();
      commandInput.focus();
    }
  };

  runButton.addEventListener('click', () => void run());
  commandInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void run();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (term.cursor > 0) {
        term.cursor -= 1;
        commandInput.value = term.history[term.cursor] ?? '';
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (term.cursor < term.history.length - 1) {
        term.cursor += 1;
        commandInput.value = term.history[term.cursor] ?? '';
      } else {
        term.cursor = term.history.length;
        commandInput.value = term.draft;
      }
    }
  });
  commandInput.addEventListener('input', () => {
    term.draft = commandInput.value;
    term.cursor = term.history.length;
  });

  paint();
  window.setTimeout(() => commandInput.focus(), 30);
  return () => {
    disposed = true;
    container.remove();
  };
}
