<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { PageData } from './$types';
  import { MawWsClient } from '$lib/client/ws';
  import Terminal from '$lib/client/components/Terminal.svelte';

  let { data }: { data: PageData } = $props();

  // Svelte warns if we seed a $state from a prop at init time — derive it
  // once from an untracked read, then keep it mutable via assignments.
  let status = $state<string>('');
  $effect(() => {
    if (!status) status = data.agent.status;
  });
  let pendingPrompt = $state<{ choices?: string[]; detail?: Record<string, unknown> } | null>(null);
  let client: MawWsClient | null = null;
  let term: Terminal | undefined = $state();

  // Base64 → Uint8Array. We hand raw bytes to xterm.js so it can decode
  // UTF-8 itself (box-drawing chars, emoji, etc.) and correctly buffer any
  // multibyte sequence that gets split across chunk boundaries.
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
      onState: (s) => (status = s)
    });
    client.connect();
    client.subscribe(data.agent.id);
  });

  function onTerminalData(bytes: string): void {
    client?.sendKeys(data.agent.id, bytes);
  }

  onDestroy(() => {
    client?.close();
  });

  function send(text: string): void {
    client?.sendInput(data.agent.id, text, true);
  }

  function answer(choice: string): void {
    client?.answerPrompt(data.agent.id, choice);
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

<header class="agent-header">
  <h1>Agent {data.agent.cli_kind}</h1>
  <span class="status">{status}</span>
</header>

<Terminal bind:this={term} onData={onTerminalData} />

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

<style>
  .agent-header {
    display: flex;
    align-items: baseline;
    gap: 1rem;
  }
  .status {
    font-size: 0.85rem;
    color: #9ca3af;
  }
  .prompt {
    margin-top: 1rem;
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
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
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
