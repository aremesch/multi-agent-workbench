<!--
  xterm.js wrapper. The heavy modules (@xterm/xterm, @xterm/addon-fit) are
  dynamic-imported inside onMount so SSR never touches browser-only code;
  xterm.css is imported statically — Vite ships it to the client bundle and
  leaves the server alone.

  Exposes an imperative write()/clear() API via `bind:this`. Writes that land
  before onMount finishes (e.g. scrollback replay racing the dynamic import)
  are queued and flushed once xterm is ready.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Terminal as XTerm } from '@xterm/xterm';
  import type { FitAddon as XFitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';

  type Props = {
    onData?: (text: string) => void;
  };

  const { onData }: Props = $props();

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
      fit.fit();

      if (onData) {
        term.onData((d) => onData(d));
      }

      for (const chunk of pending) term.write(chunk);
      pending = [];

      const handleResize = (): void => {
        try {
          fit?.fit();
        } catch {
          // xterm throws if the container is temporarily detached; ignore.
        }
      };
      window.addEventListener('resize', handleResize);

      cleanup = () => {
        window.removeEventListener('resize', handleResize);
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
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    padding: 0.5rem;
    min-height: 20rem;
    height: 60vh;
  }
  /* xterm injects its own canvas layers; make sure they fill the host */
  .terminal-host :global(.xterm) {
    height: 100%;
  }
  .terminal-host :global(.xterm-viewport) {
    background-color: transparent !important;
  }
</style>
