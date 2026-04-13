<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getMawWsClient, type AgentHandlers } from '$lib/client/ws';
  import Terminal from '$lib/client/components/Terminal.svelte';
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
  //
  // The *first* onResize after mount is special: it's how we learn the real
  // xterm dimensions, and it's what we use to issue the very first
  // `subscribe_agent` (so the server's reconnect snapshot is captured at
  // the viewer's actual width). Until that lands we haven't subscribed at
  // all — there's nothing to send a resize for.
  let lastSentCols = 0;
  let lastSentRows = 0;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let subscribed = false;
  // Holds the most recent `history_snapshot` body until the matching live
  // `scrollback` arrives. We can't write history immediately because
  // `onScrollback` calls `term.reset()` and would wipe it. Server always
  // sends history first, scrollback second, so this is the simple buffer.
  let pendingHistory: string | null = null;

  const handlers: AgentHandlers = {
    onOutput: ({ b64 }) => {
      term?.write(b64ToBytes(b64));
    },
    onHistorySnapshot: ({ body }) => {
      // Out-of-band CLI transcript prepended before the live scrollback. We
      // arrive *before* `onScrollback`, which calls `term.reset()` — so we
      // queue the body to be written immediately after that reset, otherwise
      // the live snapshot would wipe us. See `pendingHistory` below.
      pendingHistory = body;
    },
    onScrollback: ({ chunks }) => {
      // Reconnect snapshot: wipe parser state so nothing carries over
      // from a previous frame (e.g. a warm-up write before this panel
      // mounted, or a stale alt-screen mode), then prepend any history
      // body that arrived alongside this snapshot, then apply the live
      // capture. The history body is plain text already CRLF-normalized
      // server-side; the live capture is the byte-accurate current screen.
      term?.reset();
      if (pendingHistory) {
        term?.write(pendingHistory);
        pendingHistory = null;
      }
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
    const ws = getMawWsClient();
    if (!subscribed) {
      // First onResize after fit: kick off the subscribe with real dims so
      // the server resize-then-captures at the right width. No debounce —
      // we want the snapshot in flight ASAP.
      subscribed = true;
      lastSentCols = cols;
      lastSentRows = rows;
      ws.subscribe(agent.id, handlers, cols, rows);
      return;
    }
    if (cols === lastSentCols && rows === lastSentRows) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      lastSentCols = cols;
      lastSentRows = rows;
      ws.sendResize(agent.id, cols, rows);
    }, 120);
  }

  function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  onMount(() => {
    // Shared ws singleton; layout already kicked it open, but this call is
    // idempotent and guarantees a client exists before any keystrokes go
    // out. Subscribe is deferred until the first `onTerminalResize` fires
    // with real xterm dimensions — see `scheduleResize` above.
    getMawWsClient();
  });

  function onTerminalData(bytes: string): void {
    getMawWsClient().sendKeys(agent.id, bytes);
  }

  function onTerminalResize(cols: number, rows: number): void {
    scheduleResize(cols, rows);
  }

  onDestroy(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    if (subscribed) getMawWsClient().unsubscribe(agent.id);
  });

  function send(text: string): void {
    getMawWsClient().sendInput(agent.id, text, true);
  }

  function answer(choice: string): void {
    getMawWsClient().answerPrompt(agent.id, choice);
    pendingPrompt = null;
  }

  let inputText = $state('');
  function submitInput(event: SubmitEvent): void {
    event.preventDefault();
    if (!inputText.trim()) return;
    send(inputText);
    inputText = '';
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

  <form onsubmit={submitInput} class="input">
    <input
      bind:value={inputText}
      placeholder={t('agent.sendPlaceholder')}
      autocomplete="off"
    />
    <button type="submit">{t('agent.send')}</button>
  </form>
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
  .input {
    flex: 0 0 auto;
    display: flex;
    gap: 0.5rem;
  }
  .input input {
    flex: 1;
    padding: 0.5rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #111;
    color: #e5e5e5;
  }
</style>
