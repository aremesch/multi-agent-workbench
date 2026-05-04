<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/state';
  import { getMawWsClient, type AgentHandlers } from '$lib/client/ws';
  import { apiFetch } from '$lib/client/api';
  import Terminal from '$lib/client/components/Terminal.svelte';
  import BrowserView from '$lib/client/components/BrowserView.svelte';
  import StreamView from '$lib/client/components/StreamView.svelte';
  import type { MobileQuickKey } from '$lib/shared/adapterTypes';
  import {
    BROWSER_CLI_KIND,
    BROWSER_STREAM_CLI_KIND,
    isCodingCliKind
  } from '$lib/shared/browserTarget';
  import { DEFAULT_MOBILE_QUICK_KEYS_MODE, type MobileQuickKeysMode } from '$lib/shared/dashboard';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  /**
   * Self-contained agent terminal panel. Used by both the dedicated
   * /agents/[id] route and the dashboard modal, so the two views stay in
   * lock-step. Owns its own xterm instance via the child `<Terminal>`
   * component and subscribes to the shared (tab-wide) `MawWsClient` via
   * `getMawWsClient()`.
   *
   * Status is bubbled up via `onStatusChange` so the host (e.g. the
   * dashboard modal) can render it next to its own title bar instead of
   * this panel having a second header.
   *
   * For `cli_kind === 'browser'` agents, this panel renders a `<BrowserView>`
   * iframe instead of xterm — they don't have a tmux session or terminal
   * stream, just a same-origin reverse-proxied dev-server preview.
   */
  let {
    agent,
    onStatusChange
  }: {
    agent: {
      id: string;
      cli_kind: string;
      status: string;
      tmux_session: string;
      target_url?: string | null;
    };
    onStatusChange?: (status: string) => void;
  } = $props();

  const isBrowser = $derived(agent.cli_kind === BROWSER_CLI_KIND);
  const isStream = $derived(agent.cli_kind === BROWSER_STREAM_CLI_KIND);
  const isAnyBrowser = $derived(isBrowser || isStream);

  // Svelte warns if we seed $state from a prop at init time; derive it via
  // $effect so `status` stays mutable but reflects the latest status coming
  // in from agent_state messages.
  let status = $state<string>('');
  $effect(() => {
    if (!status) {
      status = agent.status;
      onStatusChange?.(agent.status);
    }
  });
  let pendingPrompt = $state<{ choices?: string[]; detail?: Record<string, unknown> } | null>(
    null
  );
  let term: Terminal | undefined = $state();

  // Debounce resize broadcasts: xterm fires onResize during the initial fit
  // as well as for every wheel of a window-drag, and we don't need to spam
  // tmux with 30 resize-window calls per drag.
  let lastSentCols = 0;
  let lastSentRows = 0;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  const handlers: AgentHandlers = {
    onOutput: ({ b64 }) => {
      term?.write(b64ToBytes(b64));
    },
    onPaneSnapshot: ({ ansi }) => {
      // Reconnect = current-pane snapshot. Wipe parser state so nothing
      // from a previous frame (or a stray pre-snapshot live byte that
      // raced the capture-pane await) leaks into how the ANSI is parsed,
      // then paint the captured grid. Empty `ansi` (fresh pane, or
      // capture-pane failed) still triggers the reset so the screen
      // stays consistent on reattach.
      term?.reset();
      if (ansi.length > 0) term?.write(ansi);
    },
    onEvent: ({ kind, choices, detail }) => {
      if (kind === 'prompt_detected') {
        pendingPrompt = { choices, detail };
      } else if (kind === 'task_done' || kind === 'ready') {
        pendingPrompt = null;
      }
    },
    onState: (s) => {
      status = s;
      onStatusChange?.(s);
    }
  };

  function scheduleResize(cols: number, rows: number): void {
    if (cols === lastSentCols && rows === lastSentRows) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      lastSentCols = cols;
      lastSentRows = rows;
      getMawWsClient().sendResize(agent.id, cols, rows);
    }, 120);
  }

  function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  let mql: MediaQueryList | null = null;
  function onTouchChange(ev: MediaQueryListEvent): void {
    isTouch = ev.matches;
  }

  onMount(() => {
    if (isAnyBrowser) {
      // Browser agents have no tmux session, no terminal_log replay, no
      // pattern-matched events. BrowserView / StreamView own their own
      // WS lifecycle. Bubble the (always 'running') status up immediately
      // so the modal title shows it without waiting for a state event.
      onStatusChange?.(agent.status);
      return;
    }
    // Subscribe immediately — protocol v5 ships a `pane_snapshot` in reply,
    // so the terminal paints the current tmux grid without waiting for any
    // resize handshake. Resize messages still flow separately through
    // `CS_Resize` once xterm reports its dimensions.
    getMawWsClient().subscribe(agent.id, handlers);
    // `(pointer: coarse)` == primary pointer is a finger. Good enough for
    // phones and tablets; desktops and laptops with a mouse/trackpad stay
    // `false` unless the user flips `mobileQuickKeysMode` to `always`.
    mql = window.matchMedia('(pointer: coarse)');
    isTouch = mql.matches;
    mql.addEventListener('change', onTouchChange);
  });

  function onTerminalData(bytes: string): void {
    getMawWsClient().sendKeys(agent.id, bytes);
  }

  function onTerminalResize(cols: number, rows: number): void {
    scheduleResize(cols, rows);
  }

  onDestroy(() => {
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (isAnyBrowser) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    getMawWsClient().unsubscribe(agent.id);
    mql?.removeEventListener('change', onTouchChange);
    mql = null;
  });

  function answer(choice: string): void {
    getMawWsClient().answerPrompt(agent.id, choice);
    pendingPrompt = null;
  }

  // ── Mobile quick-keys ──────────────────────────────────────────────
  // Phone soft keyboards hide arrow keys / Esc / Shift+Tab / Ctrl+C.
  // Each adapter declares its own preferred key-chord row in the JSONC
  // `mobileQuickKeys` field; we render them under xterm when either the
  // device is touch-primary (pointer: coarse) or the user forced the row
  // on via /settings. Each button fires bytes through the same send_keys
  // path as real xterm keystrokes, then refocuses the terminal so the
  // next real keypress lands in the PTY rather than on the button.
  const quickKeys = $derived<MobileQuickKey[]>(
    page.data.cliKinds?.find(
      (k: { kind: string; mobileQuickKeys?: MobileQuickKey[] }) => k.kind === agent.cli_kind
    )?.mobileQuickKeys ?? []
  );
  const quickKeysMode = $derived<MobileQuickKeysMode>(
    page.data.mobileQuickKeysMode ?? DEFAULT_MOBILE_QUICK_KEYS_MODE
  );
  let isTouch = $state(false);
  const showQuickKeys = $derived(
    quickKeys.length > 0 &&
      (quickKeysMode === 'always' || (quickKeysMode === 'auto' && isTouch))
  );

  function pressQuickKey(keys: string): void {
    getMawWsClient().sendKeys(agent.id, keys);
    term?.focus();
  }

  // ── Image / screenshot attachment ──────────────────────────────────
  // Three input surfaces — paste (Ctrl/Cmd+V anywhere in the modal),
  // drag-and-drop, and a paperclip button — all funnel into one helper
  // that uploads the bytes to the agent's worktree and types the
  // resulting `@<rel>` reference into the agent's prompt via the same
  // `send_keys` channel as keystrokes. The CLI then attaches the image
  // when the user submits the line. See docs/plans/v0.2-image-paste-into-agent.md.
  //
  // Gating is a *client-side* hint: the route only checks user/owner.
  // We hide the affordances for adapters that can't actually use the
  // path (browsers / shell smoke) so the UX stays clean.

  // Mirror the server limits so oversized files fail before the network
  // round-trip. Kept in sync with MAX_BYTES + ALLOWED_MIME in
  // src/lib/server/uploads/agentImageUploads.ts.
  const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

  const imagesEnabled = $derived<boolean>(
    !isAnyBrowser &&
      isCodingCliKind(agent.cli_kind) &&
      (page.data.cliKinds?.find(
        (k: { kind: string; acceptsImageAttachment?: boolean }) => k.kind === agent.cli_kind
      )?.acceptsImageAttachment ?? false)
  );

  type UploadStatus =
    | { kind: 'ok'; filename: string; relativePath: string }
    | { kind: 'err'; message: string }
    | { kind: 'uploading' }
    | null;

  let uploadStatus = $state<UploadStatus>(null);
  let dragDepth = $state(0);
  const dragActive = $derived(dragDepth > 0);
  let fileInput: HTMLInputElement | undefined = $state();
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(next: UploadStatus, autoDismissMs?: number): void {
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    uploadStatus = next;
    if (autoDismissMs && autoDismissMs > 0) {
      statusTimer = setTimeout(() => {
        uploadStatus = null;
        statusTimer = null;
      }, autoDismissMs);
    }
  }

  async function uploadAndInjectImage(file: File): Promise<void> {
    if (!imagesEnabled) return;
    if (!IMAGE_MIMES.has(file.type)) {
      setStatus({ kind: 'err', message: t('agentTerminal.image.error.mime') }, 6000);
      return;
    }
    if (file.size <= 0 || file.size > IMAGE_MAX_BYTES) {
      setStatus({ kind: 'err', message: t('agentTerminal.image.error.size') }, 6000);
      return;
    }

    setStatus({ kind: 'uploading' });

    const fd = new FormData();
    fd.set('file', file);
    let res: Response;
    try {
      res = await apiFetch(`/api/agents/${agent.id}/upload-image`, {
        method: 'POST',
        body: fd
      });
    } catch {
      setStatus({ kind: 'err', message: t('agentTerminal.image.error.upload') }, 6000);
      return;
    }

    if (!res.ok) {
      let code: string | null = null;
      try {
        const body = (await res.json()) as { code?: string };
        code = body.code ?? null;
      } catch {
        /* swallow — fall through to generic */
      }
      const msg =
        code === 'mime'
          ? t('agentTerminal.image.error.mime')
          : code === 'size'
            ? t('agentTerminal.image.error.size')
            : t('agentTerminal.image.error.upload');
      setStatus({ kind: 'err', message: msg }, 6000);
      return;
    }

    const body = (await res.json()) as {
      relativePath: string;
      filename: string;
    };
    // Spaces around the `@<path>` preserve word boundaries with whatever
    // the user already has on the prompt line. Bare path also works for
    // claude-code; the `@` prefix matches the documented mention syntax
    // across claude-code / codex / gemini.
    getMawWsClient().sendKeys(agent.id, ` @${body.relativePath} `);
    term?.focus();
    setStatus(
      { kind: 'ok', filename: body.filename, relativePath: body.relativePath },
      4000
    );
  }

  function onModalPasteCapture(ev: ClipboardEvent): void {
    if (!imagesEnabled) return;
    const items = ev.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          // Only consume the paste when we actually intercept an image —
          // text pastes still flow through to xterm.
          ev.preventDefault();
          ev.stopPropagation();
          void uploadAndInjectImage(f);
          return;
        }
      }
    }
  }

  function hasImageInDrag(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    if (dt.types && dt.types.includes('Files')) return true;
    return false;
  }

  function onDragEnter(ev: DragEvent): void {
    if (!imagesEnabled) return;
    if (!hasImageInDrag(ev.dataTransfer)) return;
    ev.preventDefault();
    dragDepth++;
  }

  function onDragOver(ev: DragEvent): void {
    if (!imagesEnabled) return;
    if (!hasImageInDrag(ev.dataTransfer)) return;
    // Required for `drop` to fire — and stops the browser from
    // navigating away if the user misses the panel and drops elsewhere.
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(ev: DragEvent): void {
    if (!imagesEnabled) return;
    if (!hasImageInDrag(ev.dataTransfer)) return;
    ev.preventDefault();
    if (dragDepth > 0) dragDepth--;
  }

  function onDrop(ev: DragEvent): void {
    if (!imagesEnabled) return;
    if (!ev.dataTransfer) return;
    const files = Array.from(ev.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/')
    );
    if (files.length === 0) return;
    ev.preventDefault();
    dragDepth = 0;
    for (const f of files) void uploadAndInjectImage(f);
  }

  function onPaperclipClick(): void {
    fileInput?.click();
  }

  function onFileInputChange(ev: Event): void {
    const target = ev.target as HTMLInputElement;
    const files = target.files ? Array.from(target.files) : [];
    for (const f of files) void uploadAndInjectImage(f);
    // Reset so re-selecting the same file still triggers a change event.
    target.value = '';
  }
</script>

{#if isStream}
  <StreamView
    agentId={agent.id}
    targetUrl={agent.target_url ?? null}
    onStopped={() => onStatusChange?.('exited')}
  />
{:else if isBrowser}
  <BrowserView
    agentId={agent.id}
    targetUrl={agent.target_url ?? null}
    onStopped={() => onStatusChange?.('exited')}
  />
{:else}
  <div
    class="panel"
    role="region"
    aria-label={t('agentTerminal.region')}
    onpastecapture={onModalPasteCapture}
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    <div class="term-wrap">
      <Terminal bind:this={term} onData={onTerminalData} onResize={onTerminalResize} />
      {#if imagesEnabled && dragActive}
        <div class="drop-overlay" aria-hidden="true">
          <span>{t('agentTerminal.image.dropOverlay')}</span>
        </div>
      {/if}
    </div>

    {#if pendingPrompt}
      <section class="prompt">
        <h2>{t('agent.promptDetected')}</h2>
        {#if pendingPrompt.detail}
          <pre>{JSON.stringify(pendingPrompt.detail, null, 2)}</pre>
        {/if}
        <div class="actions">
          {#each pendingPrompt.choices ?? ['yes', 'no'] as choice (choice)}
            <button onclick={() => answer(choice)}>{choice}</button>
          {/each}
        </div>
      </section>
    {/if}

    {#if uploadStatus}
      <div
        class="upload-status"
        class:upload-status--err={uploadStatus.kind === 'err'}
        class:upload-status--ok={uploadStatus.kind === 'ok'}
        role="status"
        aria-live="polite"
      >
        {#if uploadStatus.kind === 'uploading'}
          {t('agentTerminal.image.uploading')}
        {:else if uploadStatus.kind === 'ok'}
          {t('agentTerminal.image.toastInjected', {
            filename: uploadStatus.filename,
            path: uploadStatus.relativePath
          })}
        {:else if uploadStatus.kind === 'err'}
          {uploadStatus.message}
        {/if}
      </div>
    {/if}

    {#if imagesEnabled || showQuickKeys}
      <div class="quick-keys" aria-label={t('agent.quickKeysLabel')}>
        {#if imagesEnabled}
          <button
            type="button"
            class="quick-key quick-key--attach"
            title={t('agentTerminal.image.attach')}
            aria-label={t('agentTerminal.image.attach')}
            onclick={onPaperclipClick}
          >
            {'\u{1F4CE}'}
          </button>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            bind:this={fileInput}
            onchange={onFileInputChange}
          />
        {/if}
        {#if showQuickKeys}
          {#each quickKeys as key (key.id)}
            <button
              type="button"
              class="quick-key"
              title={key.label}
              aria-label={key.label}
              onclick={() => pressQuickKey(key.keys)}
            >
              {key.label}
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* The panel declares its own intrinsic size so the content-sized Modal
     has something concrete to wrap. Viewport-relative caps leave a small
     border around the popup and shrink naturally on small screens; the
     xterm inside flexes to whatever's left after the input/prompt rows. */
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
    position: relative;
  }
  /* Translucent overlay while a file is dragged over the modal. Pointer
     events disabled so the underlying drop handler still fires. */
  .drop-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 23, 42, 0.72);
    color: #e5e7eb;
    font-size: 1.1rem;
    font-weight: 600;
    border: 2px dashed #60a5fa;
    border-radius: 0.375rem;
    pointer-events: none;
    z-index: 5;
  }
  .upload-status {
    flex: 0 0 auto;
    padding: 0.45rem 0.65rem;
    border-radius: 0.35rem;
    font-size: 0.875rem;
    background: var(--md-sys-color-surface-container-high, #1f2937);
    color: var(--md-sys-color-on-surface, #e5e7eb);
    border: 1px solid var(--md-sys-color-outline-variant, #374151);
  }
  .upload-status--ok {
    border-color: #16a34a;
    background: #052e1a;
    color: #d1fae5;
  }
  .upload-status--err {
    border-color: #dc2626;
    background: #2c0b0b;
    color: #fecaca;
  }
  .quick-key--attach {
    font-size: 1.15rem;
  }
  .prompt {
    flex: 0 0 auto;
    padding: 0.75rem;
    border: 1px solid #b45309;
    border-radius: 0.375rem;
    background: #1f1405;
  }
  .prompt .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .prompt button {
    min-width: 4rem;
    min-height: 2.5rem;
  }
  .quick-keys {
    flex: 0 0 auto;
    display: flex;
    gap: 0.3rem;
    overflow-x: auto;
    padding-bottom: 0.15rem;
    /* Thin scrollbar so a long key row doesn't steal vertical space. */
    scrollbar-width: thin;
  }
  .quick-key {
    flex: 0 0 auto;
    min-width: 2.75rem;
    min-height: 2.75rem;
    padding: 0.3rem 0.65rem;
    border-radius: 0.4rem;
    border: 1px solid var(--md-sys-color-outline-variant, #374151);
    background: var(--md-sys-color-surface-container-high, #1f2937);
    color: var(--md-sys-color-on-surface, #e5e7eb);
    font-size: 1rem;
    font-family: ui-monospace, Menlo, Monaco, monospace;
    cursor: pointer;
    touch-action: manipulation;
  }
  .quick-key:hover {
    background: var(--md-sys-color-surface-container-highest, #374151);
  }
  .quick-key:active {
    background: var(--md-sys-color-primary-container, #2a3a52);
  }
</style>
