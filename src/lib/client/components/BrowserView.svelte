<script lang="ts">
  import { untrack } from 'svelte';
  import { apiFetch } from '$lib/client/api';
  import { parseBrowserTargetUrl } from '$lib/shared/browserTarget';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let {
    agentId,
    targetUrl,
    onStopped
  }: {
    /** Agent id — used to build the same-origin proxy URL `/preview/<id>/`. */
    agentId: string;
    /** Initial target URL captured at spawn time. Kept as the source of
     *  truth for the editable URL field; mutated via PUT /api/agents/<id>
     *  /target when the user picks a different port. May be null on legacy
     *  rows (we still render the iframe — it just shows the proxy path
     *  until the user enters a target). */
    targetUrl: string | null;
    /** Called after the agent has been transitioned to `exited`. The host
     *  modal listens to this to auto-close and archive the agent — same
     *  shape as the WS-driven `onStatusChange` path used for CLI agents. */
    onStopped?: () => void;
  } = $props();

  // ── Editable target URL ────────────────────────────────────────────────
  // Local copies so the input is editable without immediately writing to
  // the server. Apply on Enter / blur / Apply button.
  //
  // `untrack` here is intentional: we seed the writable copy once from the
  // prop and then own its lifecycle locally. The Svelte 5 warning would
  // otherwise complain about referencing a prop / `$state` inside another
  // `$state` initializer (typically a bug — but here we WANT the snapshot
  // semantics so a parent re-render with a stale prop doesn't clobber the
  // user's pending edit). Same convention as `SpawnAgentForm.svelte`.
  let liveTargetUrl = $state(untrack(() => targetUrl ?? 'http://localhost:5173'));
  let urlInput = $state(untrack(() => liveTargetUrl));
  let savingTarget = $state(false);
  let targetError = $state<string | null>(null);

  const urlInputValid = $derived(parseBrowserTargetUrl(urlInput).ok);
  const urlInputDirty = $derived(urlInput !== liveTargetUrl);

  /**
   * Common dev-server ports on a typical localhost setup. Showing a few
   * one-click chips is faster than re-typing the whole URL when a second
   * `pnpm dev` instance bumps to the next port. The list is intentionally
   * short and biased toward what Vite / SvelteKit / Next emit by default;
   * the user can still type any port into the URL field.
   */
  const COMMON_PORTS = [3000, 4173, 5173, 5174, 5175, 8080] as const;

  function urlForPort(port: number): string {
    return `http://localhost:${port}`;
  }

  /** Parse the current input's port (for highlighting the active chip). */
  const livePort = $derived.by((): number | null => {
    const r = parseBrowserTargetUrl(liveTargetUrl);
    return r.ok ? r.port : null;
  });

  async function applyTarget(newUrl: string): Promise<void> {
    const parsed = parseBrowserTargetUrl(newUrl);
    if (!parsed.ok) {
      targetError = t(`spawn.error.browserUrl.${parsed.error}`);
      return;
    }
    if (parsed.url === liveTargetUrl) {
      // No-op — also resets the input to its canonical form.
      urlInput = parsed.url;
      return;
    }
    savingTarget = true;
    targetError = null;
    try {
      const res = await apiFetch(`/api/agents/${agentId}/target`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target_url: parsed.url })
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        targetError =
          data.code && data.code.startsWith('invalid_url_')
            ? t(`spawn.error.browserUrl.${data.code.slice('invalid_url_'.length)}`)
            : t('browser.target.saveFailed');
        return;
      }
      liveTargetUrl = parsed.url;
      urlInput = parsed.url;
      reload();
    } catch (err) {
      targetError = (err as Error).message;
    } finally {
      savingTarget = false;
    }
  }

  function pickPort(port: number): void {
    void applyTarget(urlForPort(port));
  }

  function onUrlKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      void applyTarget(urlInput);
    }
  }

  // ── Viewport presets ────────────────────────────────────────────────────
  // Mobile-responsive testing is the primary use case, so the presets bias
  // toward common phone/tablet sizes. The "fit" preset removes the inner
  // viewport box and lets the iframe fill the panel — useful on a desktop
  // viewer where the user just wants the full browser surface.
  type PresetId = 'mobile' | 'tablet' | 'desktop' | 'fit' | 'custom';
  interface Preset {
    id: PresetId;
    label: string;
    width: number;
    height: number;
  }
  const presets: Preset[] = [
    { id: 'mobile', label: t('browser.preset.mobile'), width: 375, height: 812 },
    { id: 'tablet', label: t('browser.preset.tablet'), width: 768, height: 1024 },
    { id: 'desktop', label: t('browser.preset.desktop'), width: 1280, height: 800 },
    { id: 'fit', label: t('browser.preset.fit'), width: 0, height: 0 },
    { id: 'custom', label: t('browser.preset.custom'), width: 0, height: 0 }
  ];

  let presetId = $state<PresetId>('mobile');
  let customWidth = $state(414);
  let customHeight = $state(896);

  const activePreset = $derived(presets.find((p) => p.id === presetId)!);

  /** Effective width/height for the centered iframe container. `null` =
   *  let CSS take over (the "fit" preset). */
  const viewportSize = $derived.by((): { width: number; height: number } | null => {
    if (presetId === 'fit') return null;
    if (presetId === 'custom') return { width: customWidth, height: customHeight };
    return { width: activePreset.width, height: activePreset.height };
  });

  // Rotate by swapping the dimensions of either the active preset (in-memory
  // override) or the custom values. We track a flip flag rather than mutating
  // preset constants so users can return to the original by re-selecting.
  let rotated = $state(false);
  const oriented = $derived.by((): { width: number; height: number } | null => {
    const v = viewportSize;
    if (!v) return null;
    return rotated ? { width: v.height, height: v.width } : v;
  });

  // ── Iframe key — bumped to force a clean reload ─────────────────────────
  let reloadKey = $state(0);
  function reload(): void {
    reloadKey += 1;
  }

  const iframeSrc = $derived(`/preview/${agentId}/?t=${reloadKey}`);

  // ── Error handling ──────────────────────────────────────────────────────
  // We can't read load errors from a same-origin iframe reliably (the proxy
  // returns 502 with text/plain when the dev server is down). Use a fetch
  // probe instead — sends a HEAD to the proxy and surfaces a friendly
  // overlay if it fails. Refreshes alongside reloadKey.
  let unreachable = $state(false);
  let probing = $state(false);
  async function probe(): Promise<void> {
    probing = true;
    unreachable = false;
    try {
      const res = await fetch(`/preview/${agentId}/`, { method: 'HEAD' });
      // 502 == upstream unreachable (dev server down). 401/403/404 are auth
      // mismatches we don't want to mistake for "dev server down".
      if (res.status === 502) unreachable = true;
    } catch {
      // Network error — treat as unreachable.
      unreachable = true;
    } finally {
      probing = false;
    }
  }

  $effect(() => {
    // Re-probe whenever the user reloads. agentId/targetUrl never change for
    // a mounted instance.
    void reloadKey;
    void probe();
  });

  function openExternal(): void {
    window.open(`/preview/${agentId}/`, '_blank', 'noopener,noreferrer');
  }

  // ── Stop / archive ─────────────────────────────────────────────────────
  // Browser agents have no CLI to exit from the inside, so they need a UI-
  // initiated archive trigger. POST to /api/agents/:id/stop, then bubble
  // status up so the host modal closes and invalidates the dashboard.
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
      // 409 (already_archived) is treated as success — the agent is in the
      // state we wanted regardless of who flipped it first.
      onStopped?.();
    } catch (err) {
      stopError = (err as Error).message;
    } finally {
      stopping = false;
      confirmingStop = false;
    }
  }
</script>

<div class="panel">
  <div class="toolbar">
    <div class="url-row">
      <span class="url-label">URL</span>
      <input
        class="url-input"
        type="url"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        bind:value={urlInput}
        onkeydown={onUrlKey}
        disabled={savingTarget}
        aria-label={t('browser.target.urlLabel')}
      />
      {#if urlInputDirty}
        <button
          type="button"
          class="tool-btn apply-btn"
          onclick={() => applyTarget(urlInput)}
          disabled={!urlInputValid || savingTarget}
          title={t('browser.target.apply')}
        >
          {savingTarget ? '…' : t('browser.target.apply')}
        </button>
      {/if}
      <button type="button" class="tool-btn" onclick={reload} title={t('browser.reload')}
        aria-label={t('browser.reload')}>↻</button>
      <button type="button" class="tool-btn" onclick={openExternal}
        title={t('browser.openExternal')} aria-label={t('browser.openExternal')}>↗</button>
      {#if confirmingStop}
        <button
          type="button"
          class="tool-btn stop-confirm"
          onclick={stopAgent}
          disabled={stopping}
          title={t('browser.stop.confirmTitle')}
        >
          {stopping ? t('browser.stop.stopping') : t('browser.stop.confirmLabel')}
        </button>
        <button
          type="button"
          class="tool-btn"
          onclick={() => (confirmingStop = false)}
          disabled={stopping}
          title={t('browser.stop.cancel')}
        >
          ✕
        </button>
      {:else}
        <button
          type="button"
          class="tool-btn stop-btn"
          onclick={() => (confirmingStop = true)}
          title={t('browser.stop.title')}
          aria-label={t('browser.stop.title')}
        >
          ⏹ {t('browser.stop.label')}
        </button>
      {/if}
    </div>
    {#if stopError}
      <p class="stop-error">{t('browser.stop.error', { message: stopError })}</p>
    {/if}
    {#if targetError}
      <p class="stop-error">{targetError}</p>
    {/if}

    <div class="ports-row" aria-label={t('browser.target.commonPorts')}>
      <span class="url-label">{t('browser.target.commonPorts')}</span>
      {#each COMMON_PORTS as port (port)}
        <button
          type="button"
          class="port-chip"
          class:active={livePort === port}
          disabled={savingTarget}
          onclick={() => pickPort(port)}
          title={urlForPort(port)}
        >
          :{port}
        </button>
      {/each}
    </div>

    <div class="viewport-row">
      <div class="presets" role="radiogroup" aria-label={t('browser.viewport.label')}>
        {#each presets as p (p.id)}
          <button
            type="button"
            class="preset-btn"
            class:active={presetId === p.id}
            role="radio"
            aria-checked={presetId === p.id}
            onclick={() => (presetId = p.id)}
          >
            {p.label}
            {#if p.id !== 'fit' && p.id !== 'custom'}
              <span class="dim">{p.width}×{p.height}</span>
            {/if}
          </button>
        {/each}
      </div>
      {#if presetId === 'custom'}
        <label class="dim-input">
          <span>{t('browser.viewport.width')}</span>
          <input type="number" min="100" max="3840" bind:value={customWidth} />
        </label>
        <label class="dim-input">
          <span>{t('browser.viewport.height')}</span>
          <input type="number" min="100" max="3840" bind:value={customHeight} />
        </label>
      {/if}
      {#if presetId !== 'fit'}
        <button
          type="button"
          class="tool-btn"
          onclick={() => (rotated = !rotated)}
          title={t('browser.rotate')}
          aria-label={t('browser.rotate')}
        >
          ⤢
        </button>
      {/if}
    </div>
  </div>

  <div class="frame-wrap" class:fit={presetId === 'fit'}>
    {#if oriented}
      <div
        class="viewport"
        style:width="{oriented.width}px"
        style:height="{oriented.height}px"
      >
        {#key reloadKey}
          <iframe
            title={t('browser.iframeTitle')}
            src={iframeSrc}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          ></iframe>
        {/key}
      </div>
    {:else}
      <div class="viewport fit">
        {#key reloadKey}
          <iframe
            title={t('browser.iframeTitle')}
            src={iframeSrc}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          ></iframe>
        {/key}
      </div>
    {/if}

    {#if unreachable && !probing}
      <div class="overlay" role="alert">
        <h2>{t('browser.unreachable.title')}</h2>
        <p>{t('browser.unreachable.body', { url: targetUrl ?? '' })}</p>
        <button type="button" onclick={reload}>{t('browser.unreachable.retry')}</button>
      </div>
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
    gap: 0.5rem;
  }
  .toolbar {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .url-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .url-label {
    color: #6b7280;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .url-input {
    flex: 1;
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
  .url-input:disabled {
    opacity: 0.6;
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
  .ports-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: center;
  }
  .port-chip {
    padding: 0.25rem 0.5rem;
    border-radius: 0.3rem;
    border: 1px solid #374151;
    background: #1a1a1a;
    color: #d1d5db;
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
    font-family: ui-monospace, Menlo, monospace;
  }
  .port-chip:hover:not(:disabled) {
    background: #1e293b;
  }
  .port-chip:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .port-chip.active {
    background: #1e293b;
    border-color: #3b82f6;
    color: #93c5fd;
  }
  .tool-btn {
    flex: 0 0 auto;
    padding: 0.35rem 0.55rem;
    border-radius: 0.3rem;
    border: 1px solid #374151;
    background: #1a1a1a;
    color: #e5e7eb;
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }
  .tool-btn:hover {
    background: #1e293b;
  }
  .tool-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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
  .stop-error {
    margin: 0;
    color: #f87171;
    font-size: 0.8rem;
  }
  .viewport-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .preset-btn {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0.05rem;
    padding: 0.35rem 0.6rem;
    border-radius: 0.3rem;
    border: 1px solid #374151;
    background: #1a1a1a;
    color: #d1d5db;
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
  }
  .preset-btn .dim {
    font-size: 0.7rem;
    color: #6b7280;
    font-family: ui-monospace, Menlo, monospace;
  }
  .preset-btn.active {
    background: #1e293b;
    border-color: #3b82f6;
    color: #93c5fd;
  }
  .preset-btn:hover:not(.active) {
    background: #1f2937;
  }
  .dim-input {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    font-size: 0.7rem;
    color: #9ca3af;
  }
  .dim-input input {
    width: 5rem;
    padding: 0.3rem 0.4rem;
    border-radius: 0.25rem;
    border: 1px solid #374151;
    background: #111;
    color: #e5e7eb;
    font: inherit;
    font-size: 0.85rem;
  }
  .frame-wrap {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    border: 1px solid #1f2937;
    border-radius: 0.4rem;
    background: #050608;
    /* Center the viewport box; allow overflow on small screens (the user
       can scroll within the wrap to see a 768x1024 tablet viewport even on
       a phone-sized modal). */
    display: flex;
    align-items: flex-start;
    justify-content: center;
    overflow: auto;
    padding: 0.75rem;
  }
  .frame-wrap.fit {
    padding: 0;
    overflow: hidden;
  }
  .viewport {
    background: #fff;
    border-radius: 0.25rem;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    overflow: hidden;
    flex: 0 0 auto;
  }
  .viewport.fit {
    width: 100%;
    height: 100%;
    border-radius: 0;
    box-shadow: none;
    flex: 1 1 auto;
  }
  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    background: rgba(5, 6, 8, 0.92);
    color: #fca5a5;
    text-align: center;
    padding: 1.5rem;
  }
  .overlay h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .overlay p {
    margin: 0;
    color: #d1d5db;
    max-width: 30rem;
  }
  .overlay button {
    padding: 0.5rem 0.9rem;
    border-radius: 0.3rem;
    border: 1px solid #3b82f6;
    background: #1e293b;
    color: #93c5fd;
    cursor: pointer;
    font: inherit;
  }
  .overlay button:hover {
    background: #2563eb;
    color: #fff;
  }
</style>
