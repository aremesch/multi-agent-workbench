<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { PageData } from './$types';
  import { MawWsClient } from '$lib/client/ws';

  let { data }: { data: PageData } = $props();

  // Svelte warns if we seed a $state from a prop at init time — derive it
  // once from an untracked read, then keep it mutable via assignments.
  let status = $state<string>('');
  $effect(() => {
    if (!status) status = data.agent.status;
  });
  let pendingPrompt = $state<{ choices?: string[]; detail?: Record<string, unknown> } | null>(null);
  let client: MawWsClient | null = null;
  // Minimal scrollback into a <pre> until xterm.js is wired into Terminal.svelte.
  let buffer = $state('');

  onMount(() => {
    client = new MawWsClient({
      onOutput: ({ b64 }) => {
        buffer += atob(b64);
        if (buffer.length > 200_000) buffer = buffer.slice(-100_000);
      },
      onScrollback: ({ chunks }) => {
        for (const c of chunks) buffer += atob(c.b64);
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

<pre class="terminal">{buffer}</pre>

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
  .terminal {
    background: #000;
    color: #e5e7eb;
    padding: 0.75rem;
    border-radius: 0.375rem;
    white-space: pre-wrap;
    min-height: 20rem;
    max-height: 60vh;
    overflow: auto;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.85rem;
    border: 1px solid #1f2937;
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
