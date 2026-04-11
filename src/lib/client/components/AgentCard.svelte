<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import type { AgentCardRow } from '$lib/shared/types';
  import { ansiToHtml, stripAnsi } from '$lib/client/ansi';

  // TODO (plan §15b): per-agent opt-in "live xterm thumbnail" mode.
  // Default stays poll-based: we fetch /api/agents/:id/snapshot every 5s,
  // parse the SGR escapes into colored <span>s, and drop them into a <pre>.
  let {
    agent,
    onOpen,
    onMeasure
  }: {
    agent: AgentCardRow;
    onOpen: (agent: AgentCardRow) => void;
    onMeasure?: (agentId: string, cols: number, rows: number) => void;
  } = $props();

  let firstMeasureReported = false;

  let snapshotHtml = $state<string>('');
  let hasContent = $state<boolean>(false);
  let contentCols = $state<number>(1);
  let contentRows = $state<number>(1);
  let alive = $state<boolean>(true);
  let lastFetchTs = $state<number>(0);
  let loading = $state<boolean>(false);
  let intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Trim trailing blank rows from the raw capture, then derive the
   * smallest pane box that still contains every visible glyph. The plain
   * version drives the measurement (cols/rows → CSS vars) so the font
   * scales to fit *actual* content, not the nominal 200×50 spawn size
   * (which goes stale the moment an xterm viewer resizes the pane, and is
   * wrong anyway for sparse startup screens like Claude Code's welcome).
   *
   * The colored version is produced by running the retained raw lines
   * through `ansiToHtml`, so we only parse the portion of the capture
   * we're actually rendering.
   */
  function measure(
    raw: string
  ): { html: string; cols: number; rows: number } {
    const rawLines = raw.split('\n');
    const plainLines = rawLines.map((l) => stripAnsi(l).replace(/\s+$/, ''));
    let keep = plainLines.length;
    while (keep > 0 && (plainLines[keep - 1] ?? '') === '') keep--;
    let cols = 0;
    for (let i = 0; i < keep; i++) {
      const l = plainLines[i] ?? '';
      if (l.length > cols) cols = l.length;
    }
    const keptRaw = rawLines.slice(0, keep).join('\n');
    return {
      html: ansiToHtml(keptRaw),
      cols: Math.max(1, cols),
      rows: Math.max(1, keep)
    };
  }

  async function fetchSnapshot(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch(`/api/agents/${agent.id}/snapshot`);
      if (res.status === 410) {
        // The tmux session is gone — the server has (or will) mark the
        // agent as `exited`. Ask SvelteKit to re-run the load functions
        // so the page data refreshes: this card leaves `liveAgents` and
        // reappears in the archive drawer without a manual reload.
        alive = false;
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
        await invalidateAll();
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { text: string; ts: number; alive: boolean };
      const m = measure(data.text);
      snapshotHtml = m.html;
      hasContent = m.rows > 0 && m.cols > 0 && m.html.length > 0;
      contentCols = m.cols;
      contentRows = m.rows;
      lastFetchTs = data.ts;
      alive = data.alive;
      // Report the measured content box once (first non-empty snapshot) so
      // the parent grid can shrink this widget to match the terminal's
      // aspect ratio — keeps the card tight with no trailing blank space.
      if (!firstMeasureReported && m.cols > 1 && m.rows > 1) {
        firstMeasureReported = true;
        onMeasure?.(agent.id, m.cols, m.rows);
      }
    } catch {
      // Network hiccup — keep whatever we had.
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    fetchSnapshot();
    intervalId = setInterval(fetchSnapshot, 5000);
  });

  onDestroy(() => {
    if (intervalId) clearInterval(intervalId);
  });

  function handleOpen(): void {
    onOpen(agent);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpen();
    }
  }
</script>

<article class="agent-card">
  <header class="agent-card-header">
    <div class="titles">
      <span class="name"
        >{agent.project_name}{agent.task_title ? `/${agent.task_title}` : ''}</span
      >
      <span class="role">{agent.role_name}</span>
      <span class="cli">{agent.cli_kind}</span>
    </div>
    <span class="status status-{agent.status}">{agent.status}</span>
  </header>

  <!-- The body is the click target. The header hosts gridstack's drag handle
       (via the `.agent-card-header` class hook in AgentGrid.svelte), so
       clicking the header starts a drag, not an open. -->
  <div
    class="body"
    role="button"
    tabindex="0"
    onclick={handleOpen}
    onkeydown={onKey}
    aria-label="Open terminal for {agent.role_name}"
  >
    {#if !alive}
      <div class="placeholder">(tmux session gone)</div>
    {:else if !hasContent}
      <div class="placeholder">{loading ? 'loading…' : '(empty)'}</div>
    {:else}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <pre
        class="snapshot"
        style="--cols: {contentCols}; --rows: {contentRows};"
      >{@html snapshotHtml}</pre>
    {/if}
  </div>
</article>

<style>
  .agent-card {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: #0b0f17;
    border: 1px solid #1f2937;
    border-radius: 0.5rem;
    overflow: hidden;
  }
  .agent-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.35rem 0.6rem;
    background: #111827;
    border-bottom: 1px solid #1f2937;
    cursor: grab;
    user-select: none;
  }
  .agent-card-header:active {
    cursor: grabbing;
  }
  .titles {
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
    min-width: 0;
  }
  .name {
    font-size: 0.8rem;
    font-weight: 500;
    color: #e5e7eb;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .role {
    font-size: 0.7rem;
    color: #6b7280;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cli {
    font-size: 0.7rem;
    color: #6b7280;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .status {
    font-size: 0.68rem;
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    background: #1f2937;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .status-running {
    background: #065f46;
    color: #d1fae5;
  }
  .status-waiting_input {
    background: #92400e;
    color: #fef3c7;
  }
  .status-spawning,
  .status-idle {
    background: #1e3a8a;
    color: #dbeafe;
  }
  .body {
    flex: 1;
    overflow: hidden;
    cursor: pointer;
    padding: 0.25rem 0.4rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #c7d2fe;
    background: #05070d;
    /* container-type: size lets the snapshot sized in cqh/cqw shrink with
       the gridstack cell, so the entire tmux pane always fits the card. */
    container-type: size;
    position: relative;
  }
  .body:focus-visible {
    outline: 2px solid #3b82f6;
    outline-offset: -2px;
  }
  .snapshot {
    margin: 0;
    white-space: pre;
    overflow: hidden;
    width: 100%;
    height: 100%;
    /* --cols / --rows are set inline from the *measured* content box
       (trailing blank rows stripped, max non-blank line length). A
       monospace glyph is ~0.6em wide, so the font that fits the card is:
         horizontal: font * 0.6 * cols ≤ cqw  → font ≤ cqw / (cols*0.6)
         vertical:   font * 1.0 * rows ≤ cqh  → font ≤ cqh / rows
       min() picks the binding constraint so content fills whichever
       dimension is tighter with no overflow. Unlike the old hard-coded
       200×50 formula, this tracks the real pane size after xterm resize
       and sparse startup screens, so the snapshot isn't drowned in blank
       space when the card is taller/wider than the content aspect. */
    font-size: min(
      calc(100cqw / (var(--cols) * 0.6)),
      calc(100cqh / var(--rows))
    );
    line-height: 1;
  }
  .placeholder {
    color: #4b5563;
    font-style: italic;
  }
</style>
