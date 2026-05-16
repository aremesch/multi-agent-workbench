<script lang="ts">
  /**
   * Markdown plan viewer.
   *
   * Two sources, one component:
   *
   *   { kind: 'agent', agentId } — fetches the on-disk plan files in the
   *     agent's worktree (or the global `~/.claude/plans`). Multiple files
   *     get a file switcher in the header. Used by the agent-window kebab's
   *     "Show Plan" action.
   *
   *   { kind: 'task', taskId } — fetches the single `plan_md` stored on a
   *     queue entry. No file list, no switcher. Used by the Tasks page's
   *     `📄 Plan` badge.
   *
   * Both branches surface the raw `markdown` field so the "Copy markdown"
   * button in the header can write it to the clipboard without a second
   * round-trip. The HTML payload is already DOMPurify-sanitized server-side
   * so we use `{@html}` without further work — see
   * `src/lib/server/plans/agentPlans.ts`.
   */

  import Modal from './Modal.svelte';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  export type PlanSource =
    | { kind: 'agent'; agentId: string }
    | { kind: 'task'; taskId: string };

  let {
    source,
    open,
    onClose
  }: {
    source: PlanSource;
    open: boolean;
    onClose: () => void;
  } = $props();

  type AgentSource = 'local' | 'global';
  type FileSummary = {
    name: string;
    modifiedMs: number;
    sizeBytes: number;
    source: AgentSource;
  };
  type State =
    | { kind: 'loading' }
    | { kind: 'empty'; dir: string; globalDir: string }
    | {
        kind: 'viewing-agent';
        current: string;
        currentSource: AgentSource;
        html: string;
        markdown: string;
        files: FileSummary[];
        dir: string;
        globalDir: string;
      }
    | {
        kind: 'viewing-task';
        html: string;
        markdown: string;
      }
    | { kind: 'error'; message: string };

  let view = $state<State>({ kind: 'loading' });
  let lastLoadedKey = $state<string | null>(null);
  let copyState = $state<'idle' | 'copied' | 'error'>('idle');
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  // Memo key: source.kind + id. Only re-fetch when the user opens the
  // modal for a different agent / task. Reading/writing `view` inside this
  // effect would create a reactive loop, so we gate strictly on the memo.
  $effect(() => {
    if (!open) return;
    const key = sourceKey(source);
    if (!key) return;
    if (lastLoadedKey === key) return;
    lastLoadedKey = key;
    view = { kind: 'loading' };
    copyState = 'idle';
    if (source.kind === 'agent') {
      void loadAgentList(source.agentId);
    } else {
      void loadTaskPlan(source.taskId);
    }
  });

  function sourceKey(s: PlanSource): string | null {
    if (s.kind === 'agent') return s.agentId ? `agent:${s.agentId}` : null;
    return s.taskId ? `task:${s.taskId}` : null;
  }

  async function loadAgentList(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/plan`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        dir: string;
        globalDir: string;
        files: FileSummary[];
      };
      if (body.files.length === 0) {
        view = { kind: 'empty', dir: body.dir, globalDir: body.globalDir };
        return;
      }
      const first = body.files[0]!;
      await loadAgentFile(id, first, body.files, body.dir, body.globalDir);
    } catch (err) {
      view = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  async function loadAgentFile(
    id: string,
    file: FileSummary,
    files: FileSummary[],
    dir: string,
    globalDir: string
  ): Promise<void> {
    view = { kind: 'loading' };
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(id)}/plan` +
          `?file=${encodeURIComponent(file.name)}` +
          `&source=${encodeURIComponent(file.source)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        name: string;
        html: string;
        markdown: string;
      };
      view = {
        kind: 'viewing-agent',
        current: body.name,
        currentSource: file.source,
        html: body.html,
        markdown: body.markdown,
        files,
        dir,
        globalDir
      };
    } catch (err) {
      view = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  async function loadTaskPlan(taskId: string): Promise<void> {
    try {
      const res = await fetch(`/api/queue/${encodeURIComponent(taskId)}/plan`);
      if (!res.ok) {
        if (res.status === 404) {
          view = { kind: 'error', message: t('queue.error.noPlan') };
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { markdown: string; html: string };
      view = {
        kind: 'viewing-task',
        html: body.html,
        markdown: body.markdown
      };
    } catch (err) {
      view = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  function onSwitcherChange(ev: Event): void {
    if (view.kind !== 'viewing-agent') return;
    if (source.kind !== 'agent') return;
    const target = ev.target as HTMLSelectElement;
    const nextValue = target.value;
    if (!nextValue) return;
    // Switcher option values encode `source/name` so source-tagged
    // duplicates with the same basename remain distinguishable.
    const sep = nextValue.indexOf('/');
    if (sep < 0) return;
    const nextSource = nextValue.slice(0, sep) as AgentSource;
    const nextName = nextValue.slice(sep + 1);
    if (nextName === view.current && nextSource === view.currentSource) return;
    const file = view.files.find(
      (f) => f.name === nextName && f.source === nextSource
    );
    if (!file) return;
    void loadAgentFile(source.agentId, file, view.files, view.dir, view.globalDir);
  }

  function retry(): void {
    lastLoadedKey = null;
    view = { kind: 'loading' };
    copyState = 'idle';
    if (source.kind === 'agent') {
      if (source.agentId) void loadAgentList(source.agentId);
    } else {
      if (source.taskId) void loadTaskPlan(source.taskId);
    }
  }

  async function copyMarkdown(): Promise<void> {
    const md = currentMarkdown();
    if (md === null) return;
    try {
      await navigator.clipboard.writeText(md);
      copyState = 'copied';
    } catch {
      copyState = 'error';
    } finally {
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyState = 'idle';
        copyTimer = null;
      }, 1500);
    }
  }

  function currentMarkdown(): string | null {
    if (view.kind === 'viewing-agent') return view.markdown;
    if (view.kind === 'viewing-task') return view.markdown;
    return null;
  }

  const showSwitcher = $derived(
    view.kind === 'viewing-agent' && view.files.length > 1
  );

  const canCopy = $derived(
    view.kind === 'viewing-agent' || view.kind === 'viewing-task'
  );

  function modalTitle(v: State): string {
    if (v.kind === 'viewing-agent') {
      const name =
        v.currentSource === 'global'
          ? `${v.current} · ${t('plan.modal.sourceGlobal')}`
          : v.current;
      return t('plan.modal.title', { name });
    }
    if (v.kind === 'viewing-task') return t('plan.modal.titleTask');
    if (v.kind === 'empty') return t('plan.modal.titleEmpty');
    if (v.kind === 'error') return t('plan.modal.titleError');
    return t('plan.modal.titleLoading');
  }

  function fmtTime(ms: number): string {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }

  function fileLabel(file: FileSummary): string {
    const base = `${file.name} · ${fmtTime(file.modifiedMs)}`;
    return file.source === 'global'
      ? `${base} · ${t('plan.modal.sourceGlobal')}`
      : base;
  }

  function copyButtonLabel(): string {
    if (copyState === 'copied') return t('plan.modal.copied');
    if (copyState === 'error') return t('plan.modal.copyError');
    return t('plan.modal.copy');
  }
</script>

{#snippet headerRight()}
  <div class="header-right">
    {#if showSwitcher && view.kind === 'viewing-agent'}
      <label class="switcher" aria-label={t('plan.modal.switcherLabel')}>
        <select
          value={`${view.currentSource}/${view.current}`}
          onchange={onSwitcherChange}
        >
          {#each view.files as file (`${file.source}/${file.name}`)}
            <option value={`${file.source}/${file.name}`}>{fileLabel(file)}</option>
          {/each}
        </select>
      </label>
    {/if}
    <button
      type="button"
      class="copy-btn"
      disabled={!canCopy}
      onclick={copyMarkdown}
    >
      {copyButtonLabel()}
    </button>
  </div>
{/snippet}

<Modal
  {open}
  {onClose}
  title={modalTitle(view)}
  headerRight={canCopy || showSwitcher ? headerRight : undefined}
>
  <div class="plan-panel">
    {#if view.kind === 'loading'}
      <div class="status">{t('plan.modal.loading')}</div>
    {:else if view.kind === 'empty'}
      <div class="empty">
        {t('plan.modal.empty', { dir: view.dir, globalDir: view.globalDir })}
      </div>
    {:else if view.kind === 'error'}
      <div class="error">{t('plan.modal.error', { error: view.message })}</div>
      <button type="button" class="retry-btn" onclick={retry}>
        {t('plan.modal.retry')}
      </button>
    {:else}
      <article class="markdown-body">
        <!-- HTML is sanitized server-side with DOMPurify. See
             src/lib/server/plans/agentPlans.ts:renderPlanMarkdownToHtml. -->
        {@html view.html}
      </article>
    {/if}
  </div>
</Modal>

<style>
  .plan-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: min(92vw, 56rem);
    max-height: min(86vh, 58rem);
    min-height: 6rem;
    overflow: hidden;
  }
  .status,
  .empty,
  .error {
    flex: 0 0 auto;
    padding: 0.6rem 0.8rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
  }
  .status {
    color: #9ca3af;
    background: #111827;
  }
  .empty {
    color: #d1d5db;
    background: #111827;
    border: 1px dashed #1f2937;
  }
  .error {
    color: #fecaca;
    background: #7f1d1d;
  }
  .retry-btn {
    align-self: flex-start;
    background: #111827;
    border: 1px solid #1f2937;
    color: #e5e7eb;
    padding: 0.4rem 0.8rem;
    border-radius: 0.375rem;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .retry-btn:hover {
    background: #1f2937;
  }
  .header-right {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  .switcher select {
    background: #0b0f17;
    color: #e5e7eb;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    padding: 0.25rem 0.4rem;
    font-size: 0.8rem;
    max-width: 22rem;
  }
  .copy-btn {
    background: #111827;
    color: #93c5fd;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    padding: 0.25rem 0.6rem;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .copy-btn:hover:not(:disabled) {
    background: #1e293b;
    color: #bfdbfe;
  }
  .copy-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .markdown-body {
    flex: 1 1 auto;
    overflow: auto;
    padding: 0.5rem 0.75rem;
    color: #e5e7eb;
    line-height: 1.55;
    font-size: 0.95rem;
  }
  .markdown-body :global(h1) {
    font-size: 1.5rem;
    margin: 0.6rem 0 0.5rem;
    border-bottom: 1px solid #1f2937;
    padding-bottom: 0.25rem;
  }
  .markdown-body :global(h2) {
    font-size: 1.25rem;
    margin: 1rem 0 0.4rem;
    border-bottom: 1px solid #1f2937;
    padding-bottom: 0.2rem;
  }
  .markdown-body :global(h3) {
    font-size: 1.05rem;
    margin: 0.85rem 0 0.35rem;
  }
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    font-size: 0.95rem;
    margin: 0.7rem 0 0.3rem;
    color: #cbd5e1;
  }
  .markdown-body :global(p),
  .markdown-body :global(ul),
  .markdown-body :global(ol),
  .markdown-body :global(blockquote) {
    margin: 0.4rem 0;
  }
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    padding-left: 1.5rem;
  }
  .markdown-body :global(li) {
    margin: 0.15rem 0;
  }
  .markdown-body :global(blockquote) {
    border-left: 3px solid #334155;
    padding: 0.1rem 0.6rem;
    color: #cbd5e1;
    background: rgba(15, 23, 42, 0.4);
  }
  .markdown-body :global(a) {
    color: #93c5fd;
    text-decoration: underline;
  }
  .markdown-body :global(a:hover) {
    color: #bfdbfe;
  }
  .markdown-body :global(code) {
    background: #111827;
    border: 1px solid #1f2937;
    border-radius: 0.25rem;
    padding: 0.05rem 0.3rem;
    font-size: 0.85em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .markdown-body :global(pre) {
    background: #0b0f17;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    padding: 0.6rem 0.75rem;
    overflow: auto;
    margin: 0.5rem 0;
  }
  .markdown-body :global(pre code) {
    background: transparent;
    border: none;
    padding: 0;
    font-size: 0.85em;
    line-height: 1.45;
  }
  .markdown-body :global(table) {
    border-collapse: collapse;
    margin: 0.6rem 0;
  }
  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid #1f2937;
    padding: 0.3rem 0.55rem;
    font-size: 0.875rem;
    text-align: left;
  }
  .markdown-body :global(th) {
    background: #111827;
  }
  .markdown-body :global(hr) {
    border: none;
    border-top: 1px solid #1f2937;
    margin: 0.8rem 0;
  }
  .markdown-body :global(img) {
    max-width: 100%;
  }
</style>
