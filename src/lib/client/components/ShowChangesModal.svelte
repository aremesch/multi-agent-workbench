<script lang="ts">
  /**
   * "Show Changes" modal — a mobile-first git diff viewer for an agent's
   * worktree, with an on-demand AI Q&A panel.
   *
   * Backs the agent-window kebab's "Show Changes" action. Fetches structured
   * diff JSON from `/api/agents/{id}/changes` (parsed + size-capped server-side)
   * and renders it as two collapsible sections — Committed / Uncommitted — of
   * per-file cards. Cards are collapsed by default and their hunk DOM is gated
   * on an explicit `expanded` flag (not just `<details>`, which renders closed
   * children) so a huge change set stays cheap until the user drills in.
   *
   * The Q&A panel POSTs questions to `/api/agents/{id}/changes/qa`; the diff is
   * re-derived server-side, so only the small question + prior Q/A cross the
   * wire. Answers are server-sanitized HTML rendered via `{@html}`. When no LLM
   * credential is configured (`aiEnabled === false`) the panel is disabled with
   * a hint.
   */

  import Modal from './Modal.svelte';
  import { apiFetch } from '$lib/client/api';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let {
    agentId,
    open,
    onClose
  }: {
    agentId: string;
    open: boolean;
    onClose: () => void;
  } = $props();

  type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  type DiffLineType = 'context' | 'add' | 'del';
  interface DiffLine {
    type: DiffLineType;
    oldNo: number | null;
    newNo: number | null;
    text: string;
  }
  interface DiffHunk {
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
  }
  interface DiffFile {
    path: string;
    oldPath: string | null;
    status: ChangeStatus;
    added: number;
    removed: number;
    binary: boolean;
    hunks: DiffHunk[];
    truncated: boolean;
  }
  type SectionKind = 'committed' | 'uncommitted';
  type SectionNote = 'base_unavailable' | 'worktree_gone' | 'no_commits' | null;
  interface DiffSection {
    kind: SectionKind;
    files: DiffFile[];
    totalAdded: number;
    totalRemoved: number;
    truncated: boolean;
    note: SectionNote;
  }
  interface ChangesResponse {
    committed: DiffSection;
    uncommitted: DiffSection;
    baseSha: string | null;
    headSha: string | null;
    aiEnabled: boolean;
  }

  type State =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'loaded'; data: ChangesResponse };

  interface QaTurn {
    q: string;
    /** Raw markdown answer (for history); null while pending. */
    markdown: string | null;
    /** Sanitized HTML for rendering; null while pending or on error. */
    html: string | null;
    error: string | null;
  }

  let view = $state<State>({ kind: 'loading' });
  let lastLoadedKey = $state<string | null>(null);
  let expanded = $state<Record<string, boolean>>({});

  let qaTurns = $state<QaTurn[]>([]);
  let question = $state('');
  let sending = $state(false);

  // Memo-gated fetch: only reload when opened for a different agent (reading
  // `view` inside would loop, so we gate strictly on the key).
  $effect(() => {
    if (!open) return;
    if (!agentId) return;
    if (lastLoadedKey === agentId) return;
    lastLoadedKey = agentId;
    view = { kind: 'loading' };
    expanded = {};
    qaTurns = [];
    question = '';
    void load(agentId);
  });

  async function load(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/changes`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ChangesResponse;
      view = { kind: 'loaded', data };
    } catch (err) {
      view = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  function retry(): void {
    lastLoadedKey = null;
    if (agentId) {
      lastLoadedKey = agentId;
      view = { kind: 'loading' };
      void load(agentId);
    }
  }

  function fileKey(kind: SectionKind, i: number): string {
    return `${kind}:${i}`;
  }
  function toggleFile(key: string): void {
    expanded = { ...expanded, [key]: !expanded[key] };
  }

  function statusLabel(s: ChangeStatus): string {
    return t(`changes.modal.status.${s}`);
  }

  function sectionsWithChanges(data: ChangesResponse): SectionKind[] {
    const out: SectionKind[] = [];
    if (data.committed.files.length > 0) out.push('committed');
    if (data.uncommitted.files.length > 0) out.push('uncommitted');
    return out;
  }

  const isEmpty = $derived(
    view.kind === 'loaded' &&
      view.data.committed.files.length === 0 &&
      view.data.uncommitted.files.length === 0
  );

  const aiEnabled = $derived(view.kind === 'loaded' && view.data.aiEnabled);

  function noteText(note: SectionNote): string | null {
    if (note === null) return null;
    return t(`changes.modal.note.${note}`);
  }

  async function ask(): Promise<void> {
    if (view.kind !== 'loaded') return;
    const q = question.trim();
    if (!q || sending) return;
    const sections = sectionsWithChanges(view.data);
    const history = qaTurns
      .filter((turn) => turn.markdown !== null)
      .map((turn) => ({ q: turn.q, a: turn.markdown as string }));

    const idx = qaTurns.length;
    qaTurns = [...qaTurns, { q, markdown: null, html: null, error: null }];
    question = '';
    sending = true;
    try {
      const res = await apiFetch(
        `/api/agents/${encodeURIComponent(agentId)}/changes/qa`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: q, sections, history })
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        throw new Error(
          body.code === 'ai_unconfigured'
            ? t('changes.modal.aiDisabledHint')
            : t('changes.modal.qaError')
        );
      }
      const body = (await res.json()) as { html: string; markdown: string };
      qaTurns = qaTurns.map((turn, i) =>
        i === idx ? { ...turn, html: body.html, markdown: body.markdown } : turn
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      qaTurns = qaTurns.map((turn, i) => (i === idx ? { ...turn, error: message } : turn));
    } finally {
      sending = false;
    }
  }

  function onQuestionKeydown(ev: KeyboardEvent): void {
    // Enter sends; Shift+Enter inserts a newline.
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void ask();
    }
  }

  // Path display: for renames/copies, show "old → new".
  function filePath(file: DiffFile): string {
    if ((file.status === 'R' || file.status === 'C') && file.oldPath) {
      return `${file.oldPath} → ${file.path}`;
    }
    return file.path;
  }
</script>

<Modal {open} {onClose} title={t('changes.modal.title')}>
  <div class="changes-panel">
    {#if view.kind === 'loading'}
      <div class="status">{t('changes.modal.loading')}</div>
    {:else if view.kind === 'error'}
      <div class="error">{t('changes.modal.error', { error: view.message })}</div>
      <button type="button" class="retry-btn" onclick={retry}>
        {t('changes.modal.retry')}
      </button>
    {:else}
      <div class="scroll">
        {#if isEmpty}
          <div class="empty">{t('changes.modal.empty')}</div>
        {/if}
        {#each [view.data.committed, view.data.uncommitted] as section (section.kind)}
          {#if section.files.length > 0 || section.note}
            <details class="section" open={section.files.length > 0}>
              <summary>
                <span class="section-title">
                  {section.kind === 'committed'
                    ? t('changes.modal.committed')
                    : t('changes.modal.uncommitted')}
                </span>
                <span class="section-stats">
                  <span class="count">{section.files.length}</span>
                  {#if section.totalAdded > 0}<span class="add">+{section.totalAdded}</span>{/if}
                  {#if section.totalRemoved > 0}<span class="del">−{section.totalRemoved}</span
                    >{/if}
                </span>
              </summary>
              {#if noteText(section.note)}
                <div class="section-note">{noteText(section.note)}</div>
              {/if}
              {#each section.files as file, i (fileKey(section.kind, i))}
                {@const key = fileKey(section.kind, i)}
                <div class="file">
                  <button
                    type="button"
                    class="file-head"
                    aria-expanded={!!expanded[key]}
                    onclick={() => toggleFile(key)}
                  >
                    <span class="chip chip-{file.status}" title={statusLabel(file.status)}
                      >{file.status}</span
                    >
                    <span class="path"><bdi>{filePath(file)}</bdi></span>
                    <span class="file-stats">
                      {#if file.binary}
                        <span class="bin">{t('changes.modal.binary')}</span>
                      {:else}
                        {#if file.added > 0}<span class="add">+{file.added}</span>{/if}
                        {#if file.removed > 0}<span class="del">−{file.removed}</span>{/if}
                      {/if}
                    </span>
                  </button>
                  {#if expanded[key]}
                    {#if file.binary}
                      <div class="file-note">{t('changes.modal.binaryBody')}</div>
                    {:else if file.truncated}
                      <div class="file-note">{t('changes.modal.largeChange')}</div>
                    {:else if file.hunks.length === 0}
                      <div class="file-note">{t('changes.modal.noTextChange')}</div>
                    {:else}
                      {#each file.hunks as hunk (hunk.header)}
                        <div class="hunk">
                          <div class="hunk-header">{hunk.header}</div>
                          {#each hunk.lines as line, li (li)}
                            <div class="line line-{line.type}">
                              <span class="gutter">{line.oldNo ?? ''}</span>
                              <span class="gutter">{line.newNo ?? ''}</span>
                              <span class="sign"
                                >{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span
                              >
                              <span class="code">{line.text}</span>
                            </div>
                          {/each}
                        </div>
                      {/each}
                    {/if}
                  {/if}
                </div>
              {/each}
            </details>
          {/if}
        {/each}
      </div>

      <!-- ── AI Q&A panel ─────────────────────────────────────────── -->
      <div class="qa">
        {#if qaTurns.length > 0}
          <div class="qa-log">
            {#each qaTurns as turn, i (i)}
              <div class="qa-turn">
                <div class="qa-q">{turn.q}</div>
                {#if turn.error}
                  <div class="qa-a qa-a-error">{turn.error}</div>
                {:else if turn.html === null}
                  <div class="qa-a qa-a-pending">{t('changes.modal.thinking')}</div>
                {:else}
                  <!-- Server-sanitized (DOMPurify) — see renderPlanMarkdownToHtml. -->
                  <div class="qa-a markdown-body">{@html turn.html}</div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        {#if aiEnabled}
          <div class="qa-input">
            <textarea
              bind:value={question}
              rows="2"
              placeholder={t('changes.modal.askPlaceholder')}
              disabled={sending}
              onkeydown={onQuestionKeydown}
            ></textarea>
            <button
              type="button"
              class="send-btn"
              disabled={sending || !question.trim()}
              onclick={ask}
            >
              {sending ? t('changes.modal.sending') : t('changes.modal.send')}
            </button>
          </div>
        {:else}
          <div class="qa-disabled">{t('changes.modal.aiDisabledHint')}</div>
        {/if}
      </div>
    {/if}
  </div>
</Modal>

<style>
  .changes-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: min(94vw, 60rem);
    max-height: min(88vh, 60rem);
    min-height: 8rem;
    overflow: hidden;
  }
  .scroll {
    flex: 1 1 auto;
    /* Vertical scroll for the diff; horizontal is confined to each hunk so the
       page body never scrolls sideways. */
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
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

  /* ── Sections ── */
  .section {
    border: 1px solid #1f2937;
    border-radius: 0.5rem;
    overflow: hidden;
    background: #0d1220;
  }
  .section > summary {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.7rem;
    cursor: pointer;
    background: #111827;
    list-style: none;
    user-select: none;
  }
  .section > summary::-webkit-details-marker {
    display: none;
  }
  .section-title {
    font-weight: 600;
    color: #e5e7eb;
    font-size: 0.9rem;
  }
  .section-stats {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.78rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .count {
    color: #9ca3af;
  }
  .section-note {
    padding: 0.4rem 0.7rem;
    font-size: 0.8rem;
    color: #cbd5e1;
    background: rgba(15, 23, 42, 0.5);
  }

  /* ── File cards ── */
  .file {
    border-top: 1px solid #131c2e;
  }
  .file-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.7rem;
    background: transparent;
    border: none;
    color: #e5e7eb;
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  .file-head:hover {
    background: #111a2b;
  }
  .path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* rtl container + <bdi> inner: truncation eats the START of the path so the
       basename stays visible, while <bdi> keeps the path text in LTR order. */
    direction: rtl;
    text-align: left;
    font-size: 0.82rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .file-stats {
    flex: 0 0 auto;
    display: inline-flex;
    gap: 0.35rem;
    font-size: 0.76rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .add {
    color: #4ade80;
  }
  .del {
    color: #f87171;
  }
  .bin {
    color: #a78bfa;
  }
  .chip {
    flex: 0 0 auto;
    width: 1.35rem;
    text-align: center;
    border-radius: 0.25rem;
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.05rem 0;
    background: #1f2937;
    color: #cbd5e1;
  }
  .chip-A {
    background: rgba(46, 160, 67, 0.25);
    color: #4ade80;
  }
  .chip-M {
    background: rgba(56, 139, 253, 0.25);
    color: #60a5fa;
  }
  .chip-D {
    background: rgba(248, 81, 73, 0.25);
    color: #f87171;
  }
  .chip-R,
  .chip-C {
    background: rgba(167, 139, 250, 0.25);
    color: #a78bfa;
  }
  .file-note {
    padding: 0.4rem 0.7rem 0.5rem;
    font-size: 0.8rem;
    color: #9ca3af;
    font-style: italic;
  }

  /* ── Hunks (unified, single-column) ── */
  .hunk {
    /* Horizontal scroll is CONFINED here — the page body stays put. */
    overflow-x: auto;
    background: #0b0f17;
    border-top: 1px solid #131c2e;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
    line-height: 1.5;
  }
  .hunk-header {
    color: #7c93b8;
    background: #101828;
    padding: 0.15rem 0.5rem;
    white-space: pre;
    width: max-content;
    min-width: 100%;
  }
  .line {
    display: flex;
    width: max-content;
    min-width: 100%;
  }
  .gutter {
    flex: 0 0 auto;
    width: 2.6rem;
    padding: 0 0.35rem;
    text-align: right;
    color: #4b5563;
    user-select: none;
    background: rgba(255, 255, 255, 0.02);
  }
  .sign {
    flex: 0 0 auto;
    width: 1ch;
    padding: 0 0.25rem;
    text-align: center;
    color: #6b7280;
    user-select: none;
    white-space: pre;
  }
  .code {
    flex: 1 1 auto;
    white-space: pre;
    padding-right: 0.5rem;
    color: #d1d5db;
  }
  .line-add {
    background: rgba(46, 160, 67, 0.15);
    border-left: 2px solid #2ea043;
  }
  .line-add .sign {
    color: #4ade80;
  }
  .line-del {
    background: rgba(248, 81, 73, 0.15);
    border-left: 2px solid #f85149;
  }
  .line-del .sign {
    color: #f87171;
  }
  .line-context {
    border-left: 2px solid transparent;
  }

  /* ── Q&A ── */
  .qa {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border-top: 1px solid #1f2937;
    padding-top: 0.5rem;
    max-height: 45%;
    overflow: hidden;
  }
  .qa-log {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .qa-turn {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .qa-q {
    align-self: flex-end;
    max-width: 85%;
    background: #1e293b;
    color: #e5e7eb;
    padding: 0.35rem 0.6rem;
    border-radius: 0.5rem 0.5rem 0 0.5rem;
    font-size: 0.85rem;
    white-space: pre-wrap;
  }
  .qa-a {
    max-width: 92%;
    font-size: 0.85rem;
  }
  .qa-a-pending {
    color: #9ca3af;
    font-style: italic;
  }
  .qa-a-error {
    color: #fecaca;
  }
  .qa-input {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
  }
  .qa-input textarea {
    flex: 1 1 auto;
    min-width: 0;
    resize: vertical;
    background: #0b0f17;
    color: #e5e7eb;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    padding: 0.4rem 0.55rem;
    font: inherit;
    font-size: 0.85rem;
  }
  .send-btn {
    flex: 0 0 auto;
    background: #111827;
    color: #93c5fd;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    padding: 0.4rem 0.8rem;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .send-btn:hover:not(:disabled) {
    background: #1e293b;
    color: #bfdbfe;
  }
  .send-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .qa-disabled {
    font-size: 0.8rem;
    color: #9ca3af;
    background: #111827;
    border: 1px dashed #1f2937;
    border-radius: 0.375rem;
    padding: 0.5rem 0.7rem;
  }

  /* Markdown answer styling (subset of PlanViewerModal's) */
  .markdown-body {
    color: #e5e7eb;
    line-height: 1.5;
  }
  .markdown-body :global(p) {
    margin: 0.3rem 0;
  }
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: 0.3rem 0;
    padding-left: 1.3rem;
  }
  .markdown-body :global(code) {
    background: #111827;
    border: 1px solid #1f2937;
    border-radius: 0.25rem;
    padding: 0.03rem 0.25rem;
    font-size: 0.85em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .markdown-body :global(pre) {
    background: #0b0f17;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    padding: 0.5rem 0.6rem;
    overflow-x: auto;
    margin: 0.4rem 0;
  }
  .markdown-body :global(pre code) {
    background: transparent;
    border: none;
    padding: 0;
  }
  .markdown-body :global(a) {
    color: #93c5fd;
    text-decoration: underline;
  }
</style>
