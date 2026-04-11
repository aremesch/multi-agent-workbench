<script lang="ts">
  import { invalidate } from '$app/navigation';
  import type { AgentCardRow } from '$lib/shared/types';
  import Modal from '$lib/client/components/Modal.svelte';

  let {
    open,
    onClose,
    archivedAgents
  }: {
    open: boolean;
    onClose: () => void;
    archivedAgents: AgentCardRow[];
  } = $props();

  let pendingDelete = $state<AgentCardRow | null>(null);
  let removeWorktree = $state(false);
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  function askDelete(agent: AgentCardRow): void {
    pendingDelete = agent;
    removeWorktree = false;
    deleteError = null;
  }

  function cancelDelete(): void {
    pendingDelete = null;
    deleteError = null;
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete || deleting) return;
    deleting = true;
    deleteError = null;
    try {
      const qs = removeWorktree ? '?removeWorktree=1' : '';
      const res = await fetch(`/api/agents/${pendingDelete.id}${qs}`, {
        method: 'DELETE'
      });
      if (!res.ok && res.status !== 204) {
        deleteError = `Delete failed (${res.status})`;
        return;
      }
      pendingDelete = null;
      await invalidate(() => true);
    } catch (err) {
      deleteError = (err as Error).message;
    } finally {
      deleting = false;
    }
  }

  function fmt(ts: number): string {
    return new Date(ts * 1000).toLocaleString();
  }
</script>

<aside class="drawer" class:open aria-hidden={!open}>
  <header>
    <h2>Archived agents</h2>
    <button type="button" class="close" aria-label="Close" onclick={onClose}>×</button>
  </header>
  <div class="list">
    {#if archivedAgents.length === 0}
      <p class="muted">No archived agents.</p>
    {:else}
      {#each archivedAgents as agent (agent.id)}
        <div class="row">
          <div class="meta">
            <div class="name">{agent.role_name}</div>
            <div class="sub">
              <span class="status status-{agent.status}">{agent.status}</span>
              <span class="cli">{agent.cli_kind}</span>
              <span class="when">{fmt(agent.updated_at)}</span>
            </div>
          </div>
          <button type="button" class="danger" onclick={() => askDelete(agent)}>
            Delete
          </button>
        </div>
      {/each}
    {/if}
  </div>
</aside>

<Modal open={pendingDelete !== null} onClose={cancelDelete} title="Delete agent">
  {#if pendingDelete}
    <div class="confirm">
      <p>
        Delete agent <strong>{pendingDelete.role_name}</strong> ({pendingDelete.cli_kind})?
        This cannot be undone.
      </p>
      <label class="checkbox">
        <input type="checkbox" bind:checked={removeWorktree} />
        Also remove worktree directory from disk
      </label>
      {#if deleteError}
        <p class="error">{deleteError}</p>
      {/if}
      <div class="actions">
        <button type="button" onclick={cancelDelete} disabled={deleting}>Cancel</button>
        <button type="button" class="danger" onclick={confirmDelete} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  {/if}
</Modal>

<style>
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(28rem, 90vw);
    background: #0b0f17;
    border-left: 1px solid #1f2937;
    transform: translateX(100%);
    transition: transform 0.2s ease;
    display: flex;
    flex-direction: column;
    z-index: 40;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.4);
  }
  .drawer.open {
    transform: translateX(0);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #1f2937;
    background: #111827;
  }
  header h2 {
    margin: 0;
    font-size: 1rem;
    color: #e5e7eb;
  }
  .close {
    background: transparent;
    border: none;
    color: #9ca3af;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0 0.4rem;
  }
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 1rem 1rem;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.6rem 0;
    border-bottom: 1px solid #1f2937;
  }
  .meta {
    min-width: 0;
    flex: 1;
  }
  .name {
    color: #e5e7eb;
    font-size: 0.9rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 0.75rem;
    color: #6b7280;
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.15rem;
  }
  .status {
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    background: #1f2937;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    font-size: 0.68rem;
  }
  .status-crashed {
    background: #7f1d1d;
    color: #fecaca;
  }
  .status-exited {
    background: #1e293b;
    color: #cbd5e1;
  }
  .cli {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .muted {
    color: #6b7280;
    font-style: italic;
  }
  button.danger {
    background: #7f1d1d;
    color: #fee2e2;
    border: 1px solid #991b1b;
    padding: 0.35rem 0.7rem;
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: 0.8rem;
  }
  button.danger:hover:not(:disabled) {
    background: #991b1b;
  }
  button.danger:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .confirm {
    color: #e5e7eb;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .confirm p {
    margin: 0;
  }
  .checkbox {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.9rem;
    color: #d1d5db;
  }
  .error {
    color: #fca5a5;
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.5rem;
  }
  .actions button {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    background: #1f2937;
    color: #e5e5e5;
    border: 1px solid #374151;
    cursor: pointer;
  }
</style>
