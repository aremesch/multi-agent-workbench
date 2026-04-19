<!--
  xterm.js wrapper. The heavy modules (@xterm/xterm, @xterm/addon-fit) are
  dynamic-imported inside onMount so SSR never touches browser-only code;
  xterm.css is imported statically — Vite ships it to the client bundle and
  leaves the server alone.

  Exposes an imperative write()/clear()/reset() API via `bind:this`. Writes
  that land before onMount finishes (e.g. scrollback replay racing the
  dynamic import) are queued and flushed once xterm is ready.

  Sizing: the host fills 100% of its parent. A ResizeObserver reflows
  FitAddon whenever the parent changes, and each fit bubbles the resulting
  cols/rows up via `onResize` so the caller can tell the backend to resize
  the tmux pane to match — that's what stops CLI output from wrapping at
  the old spawn size.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Terminal as XTerm } from '@xterm/xterm';
  import type { FitAddon as XFitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';

  type Props = {
    onData?: (text: string) => void;
    onResize?: (cols: number, rows: number) => void;
  };

  const { onData, onResize }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let term: XTerm | null = null;
  let fit: XFitAddon | null = null;
  let pending: (string | Uint8Array)[] = [];

  /**
   * Pass a Uint8Array for raw PTY bytes so xterm can decode UTF-8 itself
   * (it buffers incomplete multibyte sequences across calls). Strings are
   * still accepted for convenience but will be interpreted as UTF-16.
   */
  export function write(data: string | Uint8Array): void {
    if (term) term.write(data);
    else pending.push(data);
  }

  export function clear(): void {
    if (term) term.clear();
    else pending = [];
  }

  /**
   * Full state wipe — clears the grid AND rebuilds xterm's parser state.
   * Used by `AgentTerminalPanel` right before applying a reconnect snapshot
   * so nothing from a previous dynamic-import warm-up write can bleed into
   * how the snapshot is interpreted (e.g. stale cursor position, lingering
   * alt-screen mode, half-parsed CSI sequence).
   */
  export function reset(): void {
    if (term) term.reset();
    else pending = [];
  }

  onMount(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      if (disposed || !container) return;

      term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontFamily: 'ui-monospace, Menlo, Monaco, "Cascadia Mono", monospace',
        fontSize: 13,
        scrollback: 10_000,
        theme: {
          background: '#000000',
          foreground: '#e5e7eb',
          cursor: '#e5e7eb',
          cursorAccent: '#000000',
          selectionBackground: '#1f2937'
        }
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      let initialFitOk = false;
      try {
        fit.fit();
        initialFitOk = true;
      } catch {
        // xterm throws if the container is 0-sized on first open (e.g. when
        // inside a <dialog> that hasn't laid out yet). The ResizeObserver
        // below will retry once the real dimensions land.
      }

      // Runs after the native <dialog> focus trap picked the close button,
      // so this wins and the user can type immediately on modal open.
      term.focus();

      if (onData) {
        term.onData((d) => onData(d));
      }
      if (onResize) {
        term.onResize(({ cols, rows }) => onResize(cols, rows));
        // Also report the post-fit dimensions unconditionally if the initial
        // fit succeeded. `term.onResize` only fires when xterm's internal
        // cols/rows *change*, so if the fit happened to produce the exact
        // dims xterm was already holding, the caller would never hear about
        // the dimensions otherwise — and tmux would keep painting at its old
        // (possibly stale) size. Skip this call if fit threw, though: the
        // cols/rows would be xterm's defaults (80×24), not real dims, and
        // downstream code that subscribes-on-first-resize would pick the
        // wrong width. The ResizeObserver below will fire a correct one
        // once the container lays out.
        if (initialFitOk) {
          onResize(term.cols, term.rows);
        }
      }

      for (const chunk of pending) term.write(chunk);
      pending = [];

      // Refit whenever the host element's box changes — modal open, window
      // resize, parent flex reflow, …
      const ro = new ResizeObserver(() => {
        if (!term || !fit) return;
        try {
          fit.fit();
          // Always report dimensions explicitly: `term.onResize` only fires
          // when cols/rows actually *change*. When the initial fit threw
          // (container was 0-sized inside a not-yet-laid-out <dialog>), the
          // ResizeObserver is the recovery path — but if the first successful
          // fit happens to produce dimensions matching xterm's defaults
          // (80×24), `term.onResize` never fires, the caller never learns
          // the real dims, and subscribe-on-first-resize never triggers.
          // Callers (AgentTerminalPanel.scheduleResize) already dedup, so
          // the extra call on subsequent resizes is harmless.
          onResize?.(term.cols, term.rows);
        } catch {
          // Container temporarily detached; ignore.
        }
      });
      ro.observe(container);

      const handleWindowResize = (): void => {
        try {
          fit?.fit();
        } catch {
          /* ignore */
        }
      };
      window.addEventListener('resize', handleWindowResize);

      cleanup = () => {
        window.removeEventListener('resize', handleWindowResize);
        ro.disconnect();
        term?.dispose();
        term = null;
        fit = null;
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  });
</script>

<div class="terminal-host" bind:this={container}></div>

<style>
  .terminal-host {
    background: #000;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  /* xterm injects its own canvas layers; make sure they fill the host. */
  .terminal-host :global(.xterm) {
    height: 100%;
    width: 100%;
  }
  .terminal-host :global(.xterm-viewport) {
    background-color: transparent !important;
  }
</style>
