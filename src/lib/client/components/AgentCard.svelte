<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import type { AgentCardRow } from '$lib/shared/types';
  import { ansiToHtml, stripAnsi } from '$lib/client/ansi';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  // TODO (plan §15b): per-agent opt-in "live xterm thumbnail" mode.
  // Default stays poll-based: we fetch /api/agents/:id/snapshot every 5s,
  // parse the SGR escapes into colored <span>s, and drop them into a <pre>.
  let {
    agent,
    onOpen
  }: {
    agent: AgentCardRow;
    onOpen: (agent: AgentCardRow) => void;
  } = $props();

  let snapshotHtml = $state<string>('');
  let hasContent = $state<boolean>(false);
  let contentCols = $state<number>(1);
  let contentRows = $state<number>(1);
  let alive = $state<boolean>(true);
  let lastFetchTs = $state<number>(0);
  let loading = $state<boolean>(false);
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let bodyEl: HTMLDivElement | undefined = $state();
  let snapshotEl: HTMLPreElement | undefined = $state();
  let bodyW = $state<number>(0);
  let bodyH = $state<number>(0);
  let resizeObserver: ResizeObserver | null = null;

  /**
   * Poll cadence. A freshly-spawned agent sits in `(empty)` while its CLI
   * boots (claude code, codex, gemini all take ~0.5–1 s to paint their
   * welcome banner), and a 5 s steady-state interval means the thumbnail
   * stays blank for up to 5 s — the user sees an empty card slide in and
   * think the spawn did nothing. Poll fast until the pane has content,
   * then settle to the steady-state rate.
   */
  const POLL_FAST_MS = 500;
  const POLL_SLOW_MS = 5000;

  /**
   * Hard cap on the "logical" column count we report for a thumbnail.
   * CLIs like Claude Code paint a full-width horizontal rule and prompt
   * box that stretch across the entire 200-col pane, so the longest
   * non-blank line is almost always 200 — which in turn forces wide
   * landscape cards. Pretending the pane is narrower lets the font-size
   * formula zoom in on the leftmost THUMB_MAX_COLS columns (the rest
   * gets clipped by `.body { overflow: hidden }`), which is plenty to
   * show the branding/welcome content that actually matters in a
   * thumbnail.
   */
  const THUMB_MAX_COLS = 80;

  /**
   * Measure the smallest content box that still contains every visible
   * glyph — trailing blank rows stripped, longest non-blank line length
   * clamped to THUMB_MAX_COLS. The card itself has a fixed grid size
   * (see AgentGrid); these numbers only feed the CSS `font-size`
   * formula so the rendered text fills as much of that fixed box as
   * possible without overflow.
   *
   * The colored version is produced by running the retained raw lines
   * through `ansiToHtml` so SGR escapes become colored <span>s.
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
      const len = (plainLines[i] ?? '').length;
      if (len > cols) cols = len;
    }
    if (cols > THUMB_MAX_COLS) cols = THUMB_MAX_COLS;
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
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
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
    } catch {
      // Network hiccup — keep whatever we had.
    } finally {
      loading = false;
    }
  }

  /**
   * Chain the next poll after the previous fetch resolves, at the rate
   * chosen by `hasContent`. Using setTimeout instead of setInterval keeps
   * the cadence honest even when a fetch takes longer than the interval
   * would have been — we always wait a full delay after the response.
   */
  async function tick(): Promise<void> {
    await fetchSnapshot();
    if (!alive) return;
    const delay = hasContent ? POLL_SLOW_MS : POLL_FAST_MS;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void tick();
    }, delay);
  }

  onMount(() => {
    void tick();
    if (bodyEl) {
      resizeObserver = new ResizeObserver((entries) => {
        const e = entries[0];
        if (!e) return;
        bodyW = e.contentRect.width;
        bodyH = e.contentRect.height;
      });
      resizeObserver.observe(bodyEl);
      bodyW = bodyEl.clientWidth;
      bodyH = bodyEl.clientHeight;
    }
  });

  onDestroy(() => {
    if (pollTimer) clearTimeout(pollTimer);
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  // Pixel font size that fits `contentCols × contentRows` glyphs (monospace
  // glyph ≈ 0.6em wide, line-height 1.0) inside the measured body box.
  // Replaces the previous CSS container-query formula, which collapsed to
  // 0 on Android Chrome when the gridstack item's box was still resolving.
  const thumbFontPx = $derived(
    bodyW > 0 && bodyH > 0
      ? Math.max(
          2,
          Math.min(bodyW / (contentCols * 0.6), bodyH / contentRows)
        )
      : 0
  );

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
        >{agent.task_title ?? agent.project_name ?? ''}</span
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
    bind:this={bodyEl}
    role="button"
    tabindex="0"
    onclick={handleOpen}
    onkeydown={onKey}
    aria-label={t('agent.openTerminal', { roleName: agent.role_name })}
  >
    {#if !alive}
      <div class="placeholder">{t('agent.tmuxGone')}</div>
    {:else if !hasContent}
      <div class="placeholder">{loading ? t('agent.loading') : t('agent.empty')}</div>
    {:else}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <pre
        class="snapshot"
        bind:this={snapshotEl}
        style="font-size: {thumbFontPx}px;"
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    line-height: 1;
  }
  .placeholder {
    color: #4b5563;
    font-style: italic;
  }
</style>
