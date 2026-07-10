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

  Mobile text selection: xterm's built-in selection is mouse-only, so on
  touch devices we add a long-press-to-select-word gesture plus two drag
  handles and a Copy/Paste toolbar (see the gesture block in onMount and the
  overlay markup below). The pure geometry/word math lives in
  ./terminalTouchSelection.ts so it can be unit-tested. Paste is offered only
  when the caller wired `onData` (the live agent terminal) — the read-only
  log replay gets Copy only.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Terminal as XTerm } from '@xterm/xterm';
  import type { FitAddon as XFitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { useT } from '$lib/client/i18n.svelte';
  import {
    cellToPixel,
    linearLength,
    normalizeEndpoints,
    pixelToCell,
    wordRangeAt,
    type Cell,
    type ScreenRect
  } from './terminalTouchSelection';

  type Props = {
    onData?: (text: string) => void;
    onResize?: (cols: number, rows: number) => void;
  };

  const { onData, onResize }: Props = $props();

  const t = useT();

  let container: HTMLDivElement | undefined = $state();
  let term: XTerm | null = null;
  let fit: XFitAddon | null = null;
  let pending: (string | Uint8Array)[] = [];

  // -- Mobile selection gesture state -----------------------------------------
  const LONG_PRESS_MS = 450;
  const MOVE_THRESHOLD_PX = 10;
  const AUTOSCROLL_MS = 80;

  // Reactive overlay geometry (host-relative px). Drives the handle/toolbar
  // markup; recomputed by refreshOverlay() on every selection/scroll/resize.
  type HandlePos = { x: number; y: number; visible: boolean };
  type ToolbarPos = { x: number; y: number; below: boolean; visible: boolean };
  let mode: 'idle' | 'selecting' = $state('idle');
  let startHandle: HandlePos | null = $state(null);
  let endHandle: HandlePos | null = $state(null);
  let toolbar: ToolbarPos | null = $state(null);
  let copied = $state(false);

  // Selection endpoints (inclusive cells, normalized start ≤ end). Reactive so
  // the handles' aria-valuenow tracks the current columns.
  let selStart: Cell = $state({ col: 0, row: 0 });
  let selEnd: Cell = $state({ col: 0, row: 0 });
  let lpTimer: ReturnType<typeof setTimeout> | null = null;
  let lpStartX = 0;
  let lpStartY = 0;
  let lpMoved = false;
  let touchOwnedBySelection = false;
  let draggingHandle: 'start' | 'end' | null = null;
  let dragAnchor: Cell | null = null;
  let autoScrollTimer: ReturnType<typeof setInterval> | null = null;
  let autoScrollDir = 0;
  let lastFingerX = 0;
  let lastFingerY = 0;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

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

  /**
   * Re-assert keyboard focus on the xterm host. Called by callers (the
   * mobile quick-key bar) that steal focus by clicking a button and need
   * the very next real keypress to land in the PTY again. Safe no-op
   * before xterm has finished loading.
   */
  export function focus(): void {
    term?.focus();
  }

  // -- Selection helpers ------------------------------------------------------

  /**
   * Live pixel geometry of the rendered `.xterm-screen`, plus its offset from
   * the host (so overlay elements can be positioned host-relative) and the
   * current grid dims / scroll offset. Null until xterm has laid out.
   */
  function screenGeom(): {
    rect: ScreenRect;
    offX: number;
    offY: number;
    cols: number;
    rows: number;
    viewportY: number;
  } | null {
    const screenEl = container?.querySelector<HTMLElement>('.xterm-screen');
    if (!container || !screenEl || !term) return null;
    const sr = screenEl.getBoundingClientRect();
    const hr = container.getBoundingClientRect();
    if (sr.width === 0 || sr.height === 0) return null;
    return {
      rect: { left: sr.left, top: sr.top, width: sr.width, height: sr.height },
      offX: sr.left - hr.left,
      offY: sr.top - hr.top,
      cols: term.cols,
      rows: term.rows,
      viewportY: term.buffer.active.viewportY
    };
  }

  function cancelLongPress(): void {
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  }

  function stopAutoScroll(): void {
    if (autoScrollTimer) {
      clearInterval(autoScrollTimer);
      autoScrollTimer = null;
    }
    autoScrollDir = 0;
  }

  /** Push the current selStart/selEnd into xterm and refresh the overlay. */
  function applySelection(a: Cell, b: Cell): void {
    if (!term) return;
    const { start, end } = normalizeEndpoints(a, b);
    selStart = start;
    selEnd = end;
    // +1: linearLength counts cells start→end exclusive; we select inclusively.
    const len = linearLength(start, end, term.cols) + 1;
    term.select(start.col, start.row, len);
    refreshOverlay();
  }

  /** Long-press landed on a stationary finger: select the word beneath it. */
  function beginSelectionAt(clientX: number, clientY: number): void {
    if (!term) return;
    const g = screenGeom();
    if (!g) return;
    const cell = pixelToCell(clientX, clientY, g.rect, g.cols, g.rows, g.viewportY);
    const line = term.buffer.active.getLine(cell.row);
    const text = line ? line.translateToString(false) : '';
    const { startCol, endCol } = wordRangeAt(text, cell.col);
    mode = 'selecting';
    applySelection(
      { col: startCol, row: cell.row },
      { col: Math.max(startCol, endCol - 1), row: cell.row }
    );
    navigator.vibrate?.(15);
    // Don't surface the soft keyboard just because a long-press blurred into a
    // selection — the user is selecting text, not typing.
    container?.querySelector<HTMLElement>('.xterm-helper-textarea')?.blur();
  }

  /** Recompute handle + toolbar pixel positions from the xterm selection. */
  function refreshOverlay(): void {
    if (mode !== 'selecting' || !term) return;
    const g = screenGeom();
    if (!g) return;
    const s = cellToPixel(selStart, g.rect, g.cols, g.rows, g.viewportY);
    const e = cellToPixel(selEnd, g.rect, g.cols, g.rows, g.viewportY);
    // Handles hang just below the line at the two selection corners.
    startHandle = { x: g.offX + s.x, y: g.offY + s.y + s.cellH, visible: s.onScreen };
    endHandle = {
      x: g.offX + e.x + e.cellW,
      y: g.offY + e.y + e.cellH,
      visible: e.onScreen
    };
    // Toolbar floats above the selection start, flipping below when it would
    // clip past the top of the terminal.
    const above = s.y >= 44;
    toolbar = {
      x: g.offX + s.x,
      y: s.onScreen ? (above ? g.offY + s.y : g.offY + s.y + s.cellH) : g.offY,
      below: !above || !s.onScreen,
      visible: s.onScreen || e.onScreen
    };
  }

  /** Tear down selection state; optionally clear xterm's own highlight. */
  function exitSelection(clearXterm: boolean): void {
    if (mode === 'idle' && !clearXterm) return;
    stopAutoScroll();
    cancelLongPress();
    draggingHandle = null;
    dragAnchor = null;
    touchOwnedBySelection = false;
    if (clearXterm) term?.clearSelection();
    mode = 'idle';
    startHandle = null;
    endHandle = null;
    toolbar = null;
  }

  // Handle drag: the grabbed handle becomes the moving "focus"; the opposite
  // endpoint is the fixed anchor, so dragging one handle past the other swaps
  // their roles (normalizeEndpoints reorders inside applySelection).
  function onHandleStart(which: 'start' | 'end', e: TouchEvent): void {
    e.stopPropagation();
    cancelLongPress();
    draggingHandle = which;
    dragAnchor = which === 'start' ? selEnd : selStart;
  }

  function onHandleMove(e: TouchEvent): void {
    e.stopPropagation();
    if (!draggingHandle || !dragAnchor || !term) return;
    const touch = e.touches[0];
    if (!touch) return;
    const g = screenGeom();
    if (!g) return;
    lastFingerX = touch.clientX;
    lastFingerY = touch.clientY;
    const focus = pixelToCell(touch.clientX, touch.clientY, g.rect, g.cols, g.rows, g.viewportY);
    applySelection(dragAnchor, focus);
    updateAutoScroll(touch.clientY, g.rect, g.rows);
  }

  function onHandleEnd(e: TouchEvent): void {
    e.stopPropagation();
    draggingHandle = null;
    dragAnchor = null;
    stopAutoScroll();
  }

  /** Extend the selection into scrollback when a handle drag nears an edge. */
  function updateAutoScroll(clientY: number, rect: ScreenRect, rows: number): void {
    const cellH = rows > 0 ? rect.height / rows : 0;
    const localY = clientY - rect.top;
    let dir = 0;
    if (localY < cellH) dir = -1;
    else if (localY > rect.height - cellH) dir = 1;
    if (dir === 0) {
      stopAutoScroll();
      return;
    }
    if (autoScrollDir === dir) return;
    stopAutoScroll();
    autoScrollDir = dir;
    autoScrollTimer = setInterval(() => {
      if (!term || !dragAnchor) return;
      term.scrollLines(dir);
      const g = screenGeom();
      if (!g) return;
      const focus = pixelToCell(lastFingerX, lastFingerY, g.rect, g.cols, g.rows, g.viewportY);
      applySelection(dragAnchor, focus);
    }, AUTOSCROLL_MS);
  }

  async function copySelection(): Promise<void> {
    const text = term?.getSelection() ?? '';
    if (!text) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = fallbackCopy(text);
    if (ok) {
      copied = true;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copied = false;
      }, 1200);
    }
  }

  // Clipboard API is unavailable in some older PWA webviews / non-secure
  // contexts; fall back to the legacy hidden-textarea + execCommand copy.
  function fallbackCopy(text: string): boolean {
    if (typeof document === 'undefined') return false;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  async function pasteClipboard(): Promise<void> {
    try {
      const text = navigator.clipboard?.readText ? await navigator.clipboard.readText() : '';
      if (text) onData?.(text);
    } catch {
      /* clipboard read denied or unavailable — ignore */
    }
    exitSelection(true);
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
        scrollOnUserInput: true,
        fontFamily: 'ui-monospace, Menlo, Monaco, "Cascadia Mono", monospace',
        fontSize: 13,
        scrollback: 10_000,
        theme: {
          background: '#000000',
          foreground: '#e5e7eb',
          cursor: '#e5e7eb',
          cursorAccent: '#000000',
          selectionBackground: '#2563eb'
        }
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      if (import.meta.env.DEV) {
        (window as unknown as { __maw_xterm?: XTerm }).__maw_xterm = term;
      }
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
      // Skip on touch devices: focusing xterm's hidden textarea while the
      // user is interacting with the modal (e.g. tapping a mobile quick-key)
      // is what makes Android surface the soft keyboard. Leaving the
      // textarea unfocused means the keyboard only opens when the user
      // taps the terminal area itself — xterm's own pointer handler then
      // focuses the textarea via a real touch gesture, which is the
      // legitimate trigger.
      const isTouch =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches;
      if (!isTouch) {
        term.focus();
      }

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

      // Keep the selection overlay glued to the text as it scrolls, and drop
      // out of selection mode if streaming output wipes xterm's selection.
      const selSub = term.onSelectionChange(() => {
        if (mode !== 'selecting') return;
        if (term && !term.hasSelection()) exitSelection(false);
        else refreshOverlay();
      });
      const scrollSub = term.onScroll(() => {
        if (mode === 'selecting') refreshOverlay();
      });

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
          if (mode === 'selecting') refreshOverlay();
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

      // Touch-to-scroll bridge + long-press text selection. xterm has NO
      // built-in touch scrolling: in v6 it bundles VS Code's Gesture class but
      // never registers a target, so touch panning is dormant, and the
      // rendered content lives in a `.xterm-screen` canvas that sits over the
      // scrollable `.xterm-viewport`, so native scroll never fires either. We
      // drive scrolling through xterm's public `scrollLines()` API rather than
      // the viewport's `scrollTop`, because v6 routes scrolling through a VS
      // Code ScrollableElement that overrides any `scrollTop` we set. Translate
      // a single-finger vertical drag over the host into whole-line scrolls,
      // carrying the sub-line pixel remainder across moves so the gesture
      // tracks the finger smoothly. A stationary single finger (no drag) that
      // dwells past LONG_PRESS_MS instead enters word-selection mode.
      let lastTouchY = 0;
      let scrollRemainder = 0;
      const onTouchStart = (e: TouchEvent): void => {
        if (e.touches.length !== 1) {
          cancelLongPress();
          return;
        }
        // A tap on the terminal body (not a handle/toolbar — those
        // stopPropagation) dismisses an active selection, then proceeds as a
        // normal touch.
        if (mode === 'selecting') exitSelection(true);
        const touch = e.touches[0]!;
        lastTouchY = touch.clientY;
        scrollRemainder = 0;
        lpStartX = touch.clientX;
        lpStartY = touch.clientY;
        lpMoved = false;
        touchOwnedBySelection = false;
        cancelLongPress();
        lpTimer = setTimeout(() => {
          lpTimer = null;
          if (lpMoved) return;
          beginSelectionAt(lpStartX, lpStartY);
          touchOwnedBySelection = true;
        }, LONG_PRESS_MS);
      };
      const onTouchMove = (e: TouchEvent): void => {
        const touch = e.touches.length === 1 ? e.touches[0] : undefined;
        if (!term || !touch) return;
        // Finger held down after a long-press selected a word: swallow moves so
        // the terminal doesn't scroll out from under the fresh selection.
        if (touchOwnedBySelection) {
          e.preventDefault();
          return;
        }
        // While the long-press timer is still pending, a small jitter keeps
        // waiting (swallow the move); crossing the threshold cancels it and
        // hands the gesture to the scroll path below.
        if (lpTimer) {
          const moved = Math.hypot(touch.clientX - lpStartX, touch.clientY - lpStartY);
          if (moved > MOVE_THRESHOLD_PX) {
            lpMoved = true;
            cancelLongPress();
          } else {
            e.preventDefault();
            return;
          }
        }
        const y = touch.clientY;
        // Finger up (y shrinks) → positive delta → scroll down toward newest.
        const dy = lastTouchY - y;
        lastTouchY = y;
        // px per row: the viewport shows exactly `term.rows` rows; fall back to
        // the configured font size if the viewport isn't measurable yet.
        const viewport = container?.querySelector<HTMLElement>('.xterm-viewport');
        const cellH =
          viewport && viewport.clientHeight > 0 ? viewport.clientHeight / term.rows : 18;
        scrollRemainder += dy;
        const lines = Math.trunc(scrollRemainder / cellH);
        if (lines !== 0) {
          scrollRemainder -= lines * cellH;
          term.scrollLines(lines);
        }
        // Only consume the gesture when there's scrollback to move through, so a
        // terminal with no history doesn't swallow the touch.
        if (term.buffer.active.baseY > 0) e.preventDefault();
      };
      const onTouchEnd = (): void => {
        cancelLongPress();
        touchOwnedBySelection = false;
      };
      // Listeners live on the host so drags starting over `.xterm-screen` are
      // captured. Only touchmove (a drag) is non-passive/preventDefault'd; a
      // plain tap is left untouched so xterm's tap-to-focus (and the deliberate
      // soft-keyboard trigger above) still works.
      container.addEventListener('touchstart', onTouchStart, { passive: true });
      container.addEventListener('touchmove', onTouchMove, { passive: false });
      container.addEventListener('touchend', onTouchEnd, { passive: true });
      container.addEventListener('touchcancel', onTouchEnd, { passive: true });

      cleanup = () => {
        window.removeEventListener('resize', handleWindowResize);
        container?.removeEventListener('touchstart', onTouchStart);
        container?.removeEventListener('touchmove', onTouchMove);
        container?.removeEventListener('touchend', onTouchEnd);
        container?.removeEventListener('touchcancel', onTouchEnd);
        cancelLongPress();
        stopAutoScroll();
        if (copiedTimer) clearTimeout(copiedTimer);
        selSub.dispose();
        scrollSub.dispose();
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

<div class="terminal-host" bind:this={container}>
  {#if mode === 'selecting'}
    <div class="sel-overlay">
      {#if startHandle?.visible}
        <div
          class="sel-handle"
          style="left:{startHandle.x}px;top:{startHandle.y}px"
          role="slider"
          aria-label={t('terminalSelect.copy')}
          aria-valuenow={selStart.col}
          tabindex="-1"
          ontouchstart={(e) => onHandleStart('start', e)}
          ontouchmove={onHandleMove}
          ontouchend={onHandleEnd}
          ontouchcancel={onHandleEnd}
        ></div>
      {/if}
      {#if endHandle?.visible}
        <div
          class="sel-handle"
          style="left:{endHandle.x}px;top:{endHandle.y}px"
          role="slider"
          aria-label={t('terminalSelect.copy')}
          aria-valuenow={selEnd.col}
          tabindex="-1"
          ontouchstart={(e) => onHandleStart('end', e)}
          ontouchmove={onHandleMove}
          ontouchend={onHandleEnd}
          ontouchcancel={onHandleEnd}
        ></div>
      {/if}
      {#if toolbar?.visible}
        <div
          class="sel-toolbar"
          class:below={toolbar.below}
          style="left:{toolbar.x}px;top:{toolbar.y}px"
          role="toolbar"
          tabindex="-1"
          ontouchstart={(e) => e.stopPropagation()}
        >
          <button type="button" onclick={copySelection}>
            {copied ? t('terminalSelect.copied') : t('terminalSelect.copy')}
          </button>
          {#if onData}
            <button type="button" onclick={pasteClipboard}>
              {t('terminalSelect.paste')}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .terminal-host {
    position: relative;
    background: #000;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    /* none: xterm has no native touch scrolling and the canvas isn't a scroll
       container, so we drive scrolling ourselves via the touch handler in
       onMount (term.scrollLines). Suppressing the browser's own pan/zoom keeps
       every touchmove cancelable — with pan-y, Android can fast-track a native
       pan of the scrollable modal ancestor and deliver non-cancelable moves
       that ignore our preventDefault, breaking the scroll. */
    touch-action: none;
  }
  /* xterm injects its own canvas layers; make sure they fill the host. */
  .terminal-host :global(.xterm) {
    height: 100%;
    width: 100%;
  }
  .terminal-host :global(.xterm-viewport) {
    background-color: transparent !important;
    touch-action: none;
  }

  /* Mobile selection overlay: transparent, click-through except its own
     handles/toolbar, layered above xterm's canvas. */
  .sel-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 5;
  }
  .sel-handle {
    position: absolute;
    width: 44px;
    height: 44px;
    /* Center the 44px hit box on the corner anchor, nudged up so the stem
       meets the text line. */
    transform: translate(-50%, -6px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    pointer-events: auto;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
    cursor: grab;
  }
  .sel-handle::before {
    content: '';
    margin-top: 6px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #2563eb;
    border: 2px solid #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  }
  .sel-handle::after {
    /* short stem connecting the knob up to the selection edge */
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 2px;
    height: 8px;
    background: #2563eb;
  }
  .sel-toolbar {
    position: absolute;
    transform: translateY(-100%) translateY(-10px);
    display: flex;
    gap: 2px;
    padding: 4px;
    background: #1f2937;
    border: 1px solid #374151;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    pointer-events: auto;
    z-index: 6;
    white-space: nowrap;
  }
  .sel-toolbar.below {
    transform: translateY(10px);
  }
  .sel-toolbar button {
    color: #e5e7eb;
    background: transparent;
    border: none;
    padding: 8px 14px;
    font-size: 13px;
    line-height: 1;
    border-radius: 6px;
    cursor: pointer;
  }
  .sel-toolbar button:active {
    background: #374151;
  }
</style>
