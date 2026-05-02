<script lang="ts">
  /**
   * One-shot xterm replay of an agent's persisted `terminal_log` —
   * served by GET /api/agents/[id]/log. Used for both archived agents
   * (the per-repo /repos/[id]/archive page) and live agents (the
   * agent-window kebab "Show Log" item).
   *
   * Race avoidance: when the modal opens, the host <dialog> goes from
   * `display: none` to visible via `dialog.showModal()`. The Terminal
   * child component mounts BEFORE that show happens, so xterm's first
   * `fit()` runs against a 0-sized container and either throws (caught
   * inside Terminal.svelte) or fits to a tiny grid (78×90 px in
   * practice, ~8 cols × 6 rows). If we wrote the bytes immediately,
   * xterm would paint the entire log into that tiny grid — every line
   * past row 6 wraps and overwrites earlier rows, producing a popup
   * that looks blank black to the user.
   *
   * The fix: hold the fetched bytes in `pendingBytes` until Terminal's
   * onResize callback fires with a real-looking grid (>= 10 cols × 4
   * rows). The ResizeObserver inside Terminal.svelte triggers that
   * callback the moment the dialog finishes laying out. Only then do
   * we reset xterm and replay the log into a properly sized buffer.
   */

  import Modal from './Modal.svelte';
  import Terminal from './Terminal.svelte';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let {
    agentId,
    title,
    open,
    onClose
  }: {
    agentId: string | null;
    title: string;
    open: boolean;
    onClose: () => void;
  } = $props();

  let term: Terminal | undefined = $state();
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);

  // The fetched bytes wait here until xterm has fitted to a real-looking
  // grid. Non-reactive — drained synchronously in `tryFlush`.
  let pendingBytes: Uint8Array | null = null;
  // Tracks whether xterm's onResize has fired with realistic dimensions
  // for the CURRENT replay. Reset on each fresh fetch so reopening with
  // a different agent doesn't keep a stale "ready" flag.
  let dimsReady = false;

  /**
   * If both halves landed (bytes fetched AND xterm fitted), reset and
   * replay. Idempotent — clears `pendingBytes` after the first flush so
   * a second `tryFlush` for the same fetch is a no-op.
   */
  function tryFlush(): void {
    if (!dimsReady || !pendingBytes || !term) return;
    const bytes = pendingBytes;
    pendingBytes = null;
    term.reset();
    term.write(bytes);
  }

  function onTerminalResize(cols: number, rows: number): void {
    // Skip the bogus tiny-grid fits that happen when the dialog hasn't
    // laid out yet. 10×4 is comfortably below any real terminal but well
    // above the 8×6 we observed when xterm fits a 0-sized container.
    if (cols < 10 || rows < 4) return;
    dimsReady = true;
    tryFlush();
  }

  // Fetch + replay each time the modal opens for a (possibly new) agent.
  $effect(() => {
    if (!open || !agentId) return;
    const id = agentId;
    loading = true;
    errorMsg = null;
    pendingBytes = null;
    dimsReady = false;
    void (async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(id)}/log`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        pendingBytes = new Uint8Array(ab);
        tryFlush();
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
      } finally {
        loading = false;
      }
    })();
  });

  // When the modal closes, drop any not-yet-flushed bytes so a
  // subsequent reopen starts cleanly.
  $effect(() => {
    if (!open) {
      pendingBytes = null;
      dimsReady = false;
    }
  });
</script>

<Modal {open} {onClose} {title}>
  <div class="panel">
    {#if errorMsg}
      <div class="error">{t('agent.failedLoadLog', { error: errorMsg })}</div>
    {:else if loading}
      <div class="status">{t('agent.loadingLog')}</div>
    {/if}
    <div class="term-wrap">
      <Terminal bind:this={term} onResize={onTerminalResize} />
    </div>
  </div>
</Modal>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    width: min(92vw, 1600px);
    height: min(88vh, 960px);
    min-height: 0;
    gap: 0.5rem;
  }
  .term-wrap {
    flex: 1 1 auto;
    min-height: 0;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    overflow: hidden;
    background: #000;
  }
  .status,
  .error {
    flex: 0 0 auto;
    font-size: 0.8rem;
    padding: 0.4rem 0.6rem;
    border-radius: 0.25rem;
  }
  .status {
    color: #9ca3af;
    background: #111827;
  }
  .error {
    color: #fecaca;
    background: #7f1d1d;
  }
</style>
