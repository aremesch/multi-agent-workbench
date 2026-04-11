<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { MawWsClient } from '$lib/client/ws';
  import Terminal from '$lib/client/components/Terminal.svelte';

  /**
   * Self-contained agent terminal panel. Used by both the dedicated
   * /agents/[id] route and the dashboard modal, so the two views stay in
   * lock-step. Owns its own WS client so it can be mounted/unmounted freely.
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
  let client: MawWsClient | null = null;
  let term: Terminal | undefined = $state();

  // Debounce resize broadcasts: xterm fires onResize during the initial fit
  // as well as for every wheel of a window-drag, and we don't need to spam
  // tmux with 30 resize-window calls per drag.
  let lastSentCols = 0;
  let lastSentRows = 0;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleResize(cols: number, rows: number): void {
    if (cols === lastSentCols && rows === lastSentRows) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      lastSentCols = cols;
      lastSentRows = rows;
      client?.sendResize(agent.id, cols, rows);
    }, 120);
  }

  function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  onMount(() => {
    client = new MawWsClient({
      onOutput: ({ b64 }) => {
        term?.write(b64ToBytes(b64));
      },
      onScrollback: ({ chunks }) => {
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
    });
    client.connect();
    client.subscribe(agent.id);
  });

  function onTerminalData(bytes: string): void {
    client?.sendKeys(agent.id, bytes);
  }

  function onTerminalResize(cols: number, rows: number): void {
    scheduleResize(cols, rows);
  }

  onDestroy(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    client?.close();
  });

  function send(text: string): void {
    client?.sendInput(agent.id, text, true);
  }

  function answer(choice: string): void {
    client?.answerPrompt(agent.id, choice);
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
      <h2>Prompt detected</h2>
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
      placeholder="Type a message, press Enter to send"
      autocomplete="off"
    />
    <button type="submit">Send</button>
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
