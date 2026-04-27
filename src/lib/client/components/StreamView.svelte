<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { apiFetch } from '$lib/client/api';
  import { getMawWsClient, type AgentHandlers } from '$lib/client/ws';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let {
    agentId,
    targetUrl,
    onStopped
  }: {
    agentId: string;
    targetUrl: string | null;
    onStopped?: () => void;
  } = $props();

  // ── Frame rendering ─────────────────────────────────────────────────────
  // We render incoming JPEG frames into an `<img>` whose src is a data URL.
  // Compared to <canvas>, it's ~half the code and the browser handles JPEG
  // decoding off the main thread. The downside is no per-frame composition,
  // but we don't need any (Chromium already composites server-side).
  let imgSrc = $state<string>('');
  let frameWidth = $state<number>(390);
  let frameHeight = $state<number>(844);
  let lastUrl = $state<string>(untrack(() => targetUrl ?? ''));
  let urlInput = $state<string>(untrack(() => targetUrl ?? ''));
  let connectionError = $state<string | null>(null);

  // Element refs for input handling.
  let imgEl: HTMLImageElement | undefined = $state();
  let containerEl: HTMLDivElement | undefined = $state();

  const handlers: AgentHandlers = {
    onOutput: () => {},
    onPaneSnapshot: () => {},
    onEvent: () => {},
    onState: () => {},
    onStreamFrame: (msg) => {
      imgSrc = `data:image/jpeg;base64,${msg.b64}`;
      frameWidth = msg.width;
      frameHeight = msg.height;
      // Ack so CDP queues the next frame. Doing it inline (not RAF-deferred)
      // because the WebSocket handler already runs after paint, and an extra
      // RAF wait halves effective frame rate without visible benefit.
      getMawWsClient().sendStreamFrameAck(agentId, msg.sessionId);
    },
    onStreamReady: (msg) => {
      lastUrl = msg.url;
      urlInput = msg.url;
      connectionError = null;
    },
    onStreamUrl: (msg) => {
      lastUrl = msg.url;
      urlInput = msg.url;
    },
    onStreamError: (msg) => {
      connectionError = msg.message;
    }
  };

  onMount(() => {
    getMawWsClient().subscribe(agentId, handlers);
    // Send the initial viewport size so the server-side page matches what
    // we're going to display. Will be re-sent on container resize.
    publishViewport();
    if (containerEl) {
      ro = new ResizeObserver(() => publishViewport());
      ro.observe(containerEl);
    }
  });

  onDestroy(() => {
    getMawWsClient().unsubscribe(agentId);
    ro?.disconnect();
    ro = null;
  });

  // ── Viewport sync ───────────────────────────────────────────────────────
  // The server-side Playwright page should resize to match what the user
  // has on screen so media queries / responsive layouts react correctly.
  // Debounce so a slow drag doesn't blast 30 setViewport calls per second.
  let ro: ResizeObserver | null = null;
  let viewportTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSentW = 0;
  let lastSentH = 0;

  function publishViewport(): void {
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    // Wait for layout: pre-mount, ResizeObserver fires once with 0×0 before
    // the first paint. Publishing that would shrink the server-side page to
    // its 100×100 minimum and nuke all the responsive content. Skip until
    // the container has real dimensions; the eventual ResizeObserver tick
    // post-paint publishes the right size.
    if (w < 200 || h < 200) return;
    if (w === lastSentW && h === lastSentH) return;
    if (viewportTimer) clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      lastSentW = w;
      lastSentH = h;
      getMawWsClient().sendStreamViewport(agentId, w, h);
    }, 150);
  }

  // ── Input forwarding ────────────────────────────────────────────────────
  // Map viewport coordinates (img-relative) to Playwright page coordinates
  // (which match the CDP-emitted frame dimensions, NOT the rendered <img>
  // size — they only differ if the <img> is letterboxed or scaled). The
  // <img> is configured object-fit: contain, so the rendered area inside
  // the image equals frameWidth × frameHeight scaled uniformly.

  function pageCoords(ev: PointerEvent): { x: number; y: number } | null {
    if (!imgEl) return null;
    const rect = imgEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // The img has CSS `object-fit: contain` which scales the JPEG to fit
    // while preserving aspect. Compute the rendered area inside the img.
    const imgAspect = frameWidth / frameHeight;
    const boxAspect = rect.width / rect.height;
    let renderW: number, renderH: number, offX: number, offY: number;
    if (imgAspect > boxAspect) {
      renderW = rect.width;
      renderH = rect.width / imgAspect;
      offX = 0;
      offY = (rect.height - renderH) / 2;
    } else {
      renderH = rect.height;
      renderW = rect.height * imgAspect;
      offX = (rect.width - renderW) / 2;
      offY = 0;
    }
    const localX = ev.clientX - rect.left - offX;
    const localY = ev.clientY - rect.top - offY;
    if (localX < 0 || localY < 0 || localX > renderW || localY > renderH) return null;
    return {
      x: Math.round((localX / renderW) * frameWidth),
      y: Math.round((localY / renderH) * frameHeight)
    };
  }

  function onPointerMove(ev: PointerEvent): void {
    const c = pageCoords(ev);
    if (!c) return;
    getMawWsClient().sendStreamPointer(agentId, 'move', c.x, c.y, ev.button, ev.buttons);
  }

  function onPointerDown(ev: PointerEvent): void {
    const c = pageCoords(ev);
    if (!c) return;
    imgEl?.focus();
    imgEl?.setPointerCapture(ev.pointerId);
    getMawWsClient().sendStreamPointer(agentId, 'down', c.x, c.y, ev.button, ev.buttons);
  }

  function onPointerUp(ev: PointerEvent): void {
    const c = pageCoords(ev);
    if (!c) return;
    imgEl?.releasePointerCapture(ev.pointerId);
    getMawWsClient().sendStreamPointer(agentId, 'up', c.x, c.y, ev.button, ev.buttons);
  }

  function onWheel(ev: WheelEvent): void {
    if (!imgEl) return;
    // Only intercept when the wheel happens over the streamed area.
    const rect = imgEl.getBoundingClientRect();
    if (
      ev.clientX < rect.left ||
      ev.clientY < rect.top ||
      ev.clientX > rect.right ||
      ev.clientY > rect.bottom
    ) return;
    ev.preventDefault();
    // Convert a fake PointerEvent at the same coords to get page-coord mapping.
    const fake = { clientX: ev.clientX, clientY: ev.clientY } as PointerEvent;
    const c = pageCoords(fake);
    if (!c) return;
    getMawWsClient().sendStreamWheel(agentId, c.x, c.y, ev.deltaX, ev.deltaY);
  }

  function onKeyDown(ev: KeyboardEvent): void {
    // Respect inputs on the URL bar — only forward keys when the streamed
    // surface has focus.
    if (document.activeElement !== imgEl) return;
    ev.preventDefault();
    getMawWsClient().sendStreamKey(agentId, 'down', ev.key, ev.code, {
      shift: ev.shiftKey,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      meta: ev.metaKey
    });
  }

  function onKeyUp(ev: KeyboardEvent): void {
    if (document.activeElement !== imgEl) return;
    ev.preventDefault();
    getMawWsClient().sendStreamKey(agentId, 'up', ev.key, ev.code, {
      shift: ev.shiftKey,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      meta: ev.metaKey
    });
  }

  // ── Toolbar actions ─────────────────────────────────────────────────────
  function reload(): void {
    getMawWsClient().sendStreamHistory(agentId, 'reload');
  }
  function goBack(): void {
    getMawWsClient().sendStreamHistory(agentId, 'back');
  }
  function goForward(): void {
    getMawWsClient().sendStreamHistory(agentId, 'forward');
  }

  function applyUrl(): void {
    const url = urlInput.trim();
    if (!url) return;
    getMawWsClient().sendStreamNavigate(agentId, url);
  }
  function onUrlKey(ev: KeyboardEvent): void {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      applyUrl();
    }
  }

  // ── Stop ────────────────────────────────────────────────────────────────
  let stopping = $state(false);
  let stopError = $state<string | null>(null);
  let confirmingStop = $state(false);
  async function stopAgent(): Promise<void> {
    if (stopping) return;
    stopping = true;
    stopError = null;
    try {
      const res = await apiFetch(`/api/agents/${agentId}/stop`, { method: 'POST' });
      if (!res.ok && res.status !== 409) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        stopError = data.error ?? `HTTP ${res.status}`;
        return;
      }
      onStopped?.();
    } catch (err) {
      stopError = (err as Error).message;
    } finally {
      stopping = false;
      confirmingStop = false;
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />

<div class="panel">
  <div class="toolbar">
    <button type="button" class="tool-btn" onclick={goBack} title={t('stream.back')} aria-label={t('stream.back')}>‹</button>
    <button type="button" class="tool-btn" onclick={goForward} title={t('stream.forward')} aria-label={t('stream.forward')}>›</button>
    <button type="button" class="tool-btn" onclick={reload} title={t('stream.reload')} aria-label={t('stream.reload')}>↻</button>
    <input
      class="url-input"
      type="url"
      inputmode="url"
      autocomplete="off"
      spellcheck="false"
      bind:value={urlInput}
      onkeydown={onUrlKey}
    />
    <button type="button" class="tool-btn apply-btn" onclick={applyUrl} disabled={!urlInput.trim() || urlInput === lastUrl}>
      {t('stream.go')}
    </button>
    {#if confirmingStop}
      <button type="button" class="tool-btn stop-confirm" onclick={stopAgent} disabled={stopping}>
        {stopping ? t('browser.stop.stopping') : t('browser.stop.confirmLabel')}
      </button>
      <button type="button" class="tool-btn" onclick={() => (confirmingStop = false)} disabled={stopping}>✕</button>
    {:else}
      <button type="button" class="tool-btn stop-btn" onclick={() => (confirmingStop = true)} title={t('browser.stop.title')}>
        ⏹ {t('browser.stop.label')}
      </button>
    {/if}
  </div>

  {#if stopError}<p class="err">{t('browser.stop.error', { message: stopError })}</p>{/if}
  {#if connectionError}<p class="err">{connectionError}</p>{/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="frame-wrap"
    role="application"
    aria-label={t('stream.imageAlt')}
    bind:this={containerEl}
    onpointermove={onPointerMove}
    onpointerdown={onPointerDown}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onwheel={onWheel}
  >
    {#if imgSrc}
      <!-- The img is the interactive surface for the streamed browser; we
           want it focusable so keyboard input forwards via the window-level
           keydown/keyup listeners. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <img
        bind:this={imgEl}
        src={imgSrc}
        alt={t('stream.imageAlt')}
        tabindex="0"
        draggable="false"
      />
    {:else}
      <div class="placeholder">{t('stream.connecting')}</div>
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    width: min(96vw, 1600px);
    height: min(92vh, 1100px);
    min-height: 0;
    gap: 0.4rem;
  }
  .toolbar {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: center;
  }
  .tool-btn {
    flex: 0 0 auto;
    padding: 0.35rem 0.6rem;
    border-radius: 0.3rem;
    border: 1px solid #374151;
    background: #1a1a1a;
    color: #e5e7eb;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    line-height: 1;
  }
  .tool-btn:hover:not(:disabled) {
    background: #1e293b;
  }
  .tool-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .apply-btn {
    color: #93c5fd;
    border-color: #3b82f6;
    background: #1e293b;
  }
  .apply-btn:hover:not(:disabled) {
    background: #2563eb;
    color: #fff;
  }
  .stop-btn {
    color: #fca5a5;
    border-color: #7f1d1d;
  }
  .stop-btn:hover {
    background: #2a0d0d;
  }
  .stop-confirm {
    color: #fff;
    background: #b91c1c;
    border-color: #b91c1c;
  }
  .stop-confirm:hover:not(:disabled) {
    background: #dc2626;
  }
  .url-input {
    flex: 1 1 12rem;
    min-width: 8rem;
    padding: 0.35rem 0.5rem;
    border-radius: 0.3rem;
    border: 1px solid #374151;
    background: #111827;
    color: #93c5fd;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.85rem;
  }
  .url-input:focus {
    outline: 2px solid #3b82f6;
    outline-offset: -1px;
  }
  .err {
    margin: 0;
    color: #f87171;
    font-size: 0.8rem;
  }
  .frame-wrap {
    flex: 1 1 auto;
    min-height: 0;
    border: 1px solid #1f2937;
    border-radius: 0.4rem;
    background: #050608;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    /* Important: touch-action none so pointer-events are forwarded as
       mouse-equivalent input rather than scrolling the surrounding panel. */
    touch-action: none;
    user-select: none;
  }
  img {
    max-width: 100%;
    max-height: 100%;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
    cursor: default;
    /* Avoid the default focus ring on an img that needs to be clickable. */
    outline: none;
  }
  img:focus-visible {
    outline: 2px solid #3b82f6;
    outline-offset: 2px;
  }
  .placeholder {
    color: #6b7280;
    font-style: italic;
  }
</style>
