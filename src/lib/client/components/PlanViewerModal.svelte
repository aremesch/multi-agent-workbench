<script lang="ts">
  /**
   * Markdown plan viewer for the agent-window kebab "Show Plan" action.
   *
   * Lifecycle on open:
   *   1. GET /api/agents/{id}/plan → { dir, files: [...] } sorted by mtime desc.
   *   2. If files is empty → render the empty state with the resolved dir.
   *      Else fetch ?file=files[0].name and render its sanitized HTML.
   *   3. When files.length > 1, the modal header gains a small <select>
   *      switcher; choosing another file re-fetches that file.
   *
   * The HTML payload is already DOMPurify-sanitized server-side so we
   * use {@html} without further work — see src/lib/server/plans/agentPlans.ts.
   */

  import Modal from './Modal.svelte';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let {
    agentId,
    open,
    onClose
  }: {
    agentId: string | null;
    open: boolean;
    onClose: () => void;
  } = $props();

  type PlanSource = 'local' | 'global';
  type FileSummary = {
    name: string;
    modifiedMs: number;
    sizeBytes: number;
    source: PlanSource;
  };
  type State =
    | { kind: 'loading' }
    | { kind: 'empty'; dir: string; globalDir: string }
    | {
        kind: 'viewing';
        current: string;
        currentSource: PlanSource;
        html: string;
        files: FileSummary[];
        dir: string;
        globalDir: string;
      }
    | { kind: 'error'; message: string };

  let view: State = $state({ kind: 'loading' });
  let lastLoadedAgentId: string | null = $state(null);

  // Fetch the file list the first time the modal opens for a given agent.
  // Reads and writes to `view` would create a reactive loop, so we gate
  // strictly on `lastLoadedAgentId` (an opaque memo, never read in the
  // template). Retries go through the explicit retry() handler below.
  $effect(() => {
    if (!open || !agentId) return;
    const id = agentId;
    if (lastLoadedAgentId === id) return;
    lastLoadedAgentId = id;
    view = { kind: 'loading' };
    void loadList(id);
  });

  async function loadList(id: string): Promise<void> {
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
      // Auto-pick the most recently modified plan and render it.
      const first = body.files[0]!;
      await loadFile(id, first, body.files, body.dir, body.globalDir);
    } catch (err) {
      view = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  async function loadFile(
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
      const body = (await res.json()) as { name: string; html: string };
      view = {
        kind: 'viewing',
        current: body.name,
        currentSource: file.source,
        html: body.html,
        files,
        dir,
        globalDir
      };
    } catch (err) {
      view = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  function onSwitcherChange(ev: Event): void {
    if (view.kind !== 'viewing' || !agentId) return;
    const target = ev.target as HTMLSelectElement;
    const nextValue = target.value;
    if (!nextValue) return;
    // Switcher option values encode `source/name` so source-tagged
    // duplicates with the same basename remain distinguishable.
    const sep = nextValue.indexOf('/');
    if (sep < 0) return;
    const nextSource = nextValue.slice(0, sep) as PlanSource;
    const nextName = nextValue.slice(sep + 1);
    if (nextName === view.current && nextSource === view.currentSource) return;
    const file = view.files.find(
      (f) => f.name === nextName && f.source === nextSource
    );
    if (!file) return;
    void loadFile(agentId, file, view.files, view.dir, view.globalDir);
  }

  function retry(): void {
    if (!agentId) return;
    view = { kind: 'loading' };
    void loadList(agentId);
  }

  function modalTitle(v: State): string {
    if (v.kind === 'viewing') {
      const name =
        v.currentSource === 'global'
          ? `${v.current} · ${t('plan.modal.sourceGlobal')}`
          : v.current;
      return t('plan.modal.title', { name });
    }
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
</script>

{#snippet headerSwitcher()}
  {#if view.kind === 'viewing' && view.files.length > 1}
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
{/snippet}

<Modal
  {open}
  {onClose}
  title={modalTitle(view)}
  headerRight={view.kind === 'viewing' && view.files.length > 1 ? headerSwitcher : undefined}
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
             src/lib/server/plans/agentPlans.ts:renderAgentPlan. -->
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
  .switcher select {
    background: #0b0f17;
    color: #e5e7eb;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    padding: 0.25rem 0.4rem;
    font-size: 0.8rem;
    max-width: 22rem;
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
