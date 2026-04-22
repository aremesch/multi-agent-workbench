<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/state';
  import { getMawWsClient, type AgentHandlers } from '$lib/client/ws';
  import Terminal from '$lib/client/components/Terminal.svelte';
  import type { MobileQuickKey } from '$lib/shared/adapterTypes';
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
   */
  let {
    agent,
    onStatusChange
  }: {
    agent: { id: string; cli_kind: string; status: string; tmux_session: string };
    onStatusChange?: (status: string) => void;
  } = $props();

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
    onScrollback: ({ chunks }) => {
      // Reconnect = byte-log replay. Wipe parser state so nothing carries
      // over from a previous frame, then write each persisted chunk in seq
      // order. Empty `chunks` (fresh agent, or no new bytes since lastSeq)
      // still triggers the reset — keeps the screen consistent on reattach.
      term?.reset();
      for (const c of chunks) term?.write(b64ToBytes(c.b64));
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
    // Subscribe immediately — protocol v4 dropped dims from `subscribe_agent`,
    // so we no longer need to wait for the first xterm resize before kicking
    // off the byte-log replay. Resize messages still flow separately through
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
</script>

<div class="panel">
  <div class="term-wrap">
    <Terminal bind:this={term} onData={onTerminalData} onResize={onTerminalResize} />
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

  {#if showQuickKeys}
    <div class="quick-keys" aria-label={t('agent.quickKeysLabel')}>
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
    </div>
  {/if}
</div>

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
