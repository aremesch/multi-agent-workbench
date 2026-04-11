<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import type { AgentCardRow } from '$lib/shared/types';

  // TODO (plan §15b): per-agent opt-in "live xterm thumbnail" mode.
  // Default stays poll-based: we fetch /api/agents/:id/snapshot every 5s,
  // strip ANSI server-side, and render as plain <pre>.
  let {
    agent,
    onOpen
  }: {
    agent: AgentCardRow;
    onOpen: (agent: AgentCardRow) => void;
  } = $props();

  let snapshotText = $state<string>('');
  let alive = $state<boolean>(true);
  let lastFetchTs = $state<number>(0);
  let loading = $state<boolean>(false);
  let intervalId: ReturnType<typeof setInterval> | null = null;

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
      snapshotText = data.text;
      lastFetchTs = data.ts;
      alive = data.alive;
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
      <span class="name">{agent.role_name}</span>
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
    {:else if snapshotText.length === 0}
      <div class="placeholder">{loading ? 'loading…' : '(empty)'}</div>
    {:else}
      <pre class="snapshot">{snapshotText}</pre>
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
    /* Tmux spawns panes at 200 cols x 50 rows (see TmuxSession.newSession).
       A monospace glyph is ~0.6em wide, so we pick the smaller of the
       horizontal and vertical limits so the full pane fits the card:
       horizontal: font * 0.6 * 200 ≤ width  → font ≤ width / 120
       vertical:   font * 1.0 *  50 ≤ height → font ≤ height / 50      */
    font-size: min(0.82cqw, 1.95cqh);
    line-height: 1;
  }
  .placeholder {
    color: #4b5563;
    font-style: italic;
  }
</style>
