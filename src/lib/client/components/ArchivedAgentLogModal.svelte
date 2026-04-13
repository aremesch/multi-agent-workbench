<script lang="ts">
  import Modal from './Modal.svelte';
  import Terminal from './Terminal.svelte';

  let {
    agentId,
    title,
    open,
    onClose
  }: {
    agentId: string | null;
    title: string;
    open: boolean;
    onClose: () => void;
  } = $props();

  let term: Terminal | undefined = $state();
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);

  // Fetch + replay each time a new agent is opened.
  $effect(() => {
    if (!open || !agentId) return;
    const id = agentId;
    loading = true;
    errorMsg = null;
    void (async () => {
      try {
        const res = await fetch(`/api/agents/${id}/log`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        // Wait one tick so Terminal has mounted into the dialog.
        await Promise.resolve();
        term?.reset();
        term?.write(new Uint8Array(ab));
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
      } finally {
        loading = false;
      }
    })();
  });
</script>

<Modal {open} {onClose} {title}>
  <div class="panel">
    {#if errorMsg}
      <div class="error">Failed to load log: {errorMsg}</div>
    {:else if loading}
      <div class="status">Loading log…</div>
    {/if}
    <div class="term-wrap">
      <Terminal bind:this={term} />
    </div>
  </div>
</Modal>

<style>
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
  .status,
  .error {
    flex: 0 0 auto;
    font-size: 0.8rem;
    padding: 0.4rem 0.6rem;
    border-radius: 0.25rem;
  }
  .status {
    color: #9ca3af;
    background: #111827;
  }
  .error {
    color: #fecaca;
    background: #7f1d1d;
  }
</style>
