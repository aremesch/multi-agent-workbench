<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';
  import type { AgentCardRow, LayoutEntry } from '$lib/shared/types';
  import AgentGrid from '$lib/client/components/AgentGrid.svelte';
  import AgentTerminalPanel from '$lib/client/components/AgentTerminalPanel.svelte';
  import Modal from '$lib/client/components/Modal.svelte';
  import SpawnAgentForm from '$lib/client/components/SpawnAgentForm.svelte';

  let { data }: { data: PageData } = $props();

  let openAgent = $state<AgentCardRow | null>(null);
  let openAgentStatus = $state<string>('');
  let spawnOpen = $state(false);

  function onOpen(agent: AgentCardRow): void {
    openAgent = agent;
    openAgentStatus = agent.status;
  }
  function closeModal(): void {
    openAgent = null;
    openAgentStatus = '';
  }

  async function saveLayout(layout: LayoutEntry[]): Promise<void> {
    try {
      await fetch('/api/user/dashboard-layout', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layout })
      });
    } catch {
      // Non-fatal — layout will just rebuild from defaults next load.
    }
  }

  function spawnAgent(): void {
    spawnOpen = true;
  }

  async function onSpawnSuccess(agentId: string): Promise<void> {
    spawnOpen = false;
    // Refresh dashboard data so the new card lands in `data.liveAgents`,
    // then pop the agent's terminal modal right over the dashboard —
    // no navigation, no full-page /agents/:id detour.
    await invalidateAll();
    const fresh = (data.liveAgents as AgentCardRow[]).find((a) => a.id === agentId);
    if (fresh) {
      openAgent = fresh;
    }
  }
</script>

<main>
  <AgentGrid
    agents={data.liveAgents as AgentCardRow[]}
    initialLayout={data.dashboardLayout}
    onLayoutChange={saveLayout}
    {onOpen}
  />
</main>

<button type="button" class="fab" aria-label="Spawn agent" onclick={spawnAgent}>
  <span aria-hidden="true">+</span>
</button>

{#snippet statusBadge()}
  <span class="status status-{openAgentStatus}">{openAgentStatus}</span>
{/snippet}

<Modal
  open={openAgent !== null}
  onClose={closeModal}
  title={openAgent ? `${openAgent.role_name} — ${openAgent.cli_kind}` : ''}
  headerRight={openAgentStatus ? statusBadge : undefined}
>
  {#if openAgent}
    <AgentTerminalPanel
      agent={{
        id: openAgent.id,
        cli_kind: openAgent.cli_kind,
        status: openAgent.status,
        tmux_session: openAgent.tmux_session
      }}
      onStatusChange={(s) => (openAgentStatus = s)}
    />
  {/if}
</Modal>

<Modal open={spawnOpen} onClose={() => (spawnOpen = false)} title="Spawn agent">
  {#if spawnOpen}
    <SpawnAgentForm
      roles={data.spawnRoles}
      repos={data.spawnRepos}
      onSuccess={onSpawnSuccess}
      onCancel={() => (spawnOpen = false)}
    />
  {/if}
</Modal>

<style>
  main {
    min-height: 60vh;
  }
  .fab {
    position: fixed;
    right: 2rem;
    bottom: 2rem;
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 50%;
    background: #2563eb;
    color: #fff;
    border: none;
    font-size: 1.75rem;
    cursor: pointer;
    box-shadow: 0 6px 18px rgba(37, 99, 235, 0.45);
    z-index: 30;
  }
  .fab:hover {
    background: #1d4ed8;
  }

  /* Status pill rendered in the terminal-modal title bar. Matches the grid
     tile's colors so the same state reads the same in both places. */
  .status {
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
    border-radius: 0.25rem;
    background: #1f2937;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    font-weight: 500;
  }
  .status-running {
    background: #065f46;
    color: #d1fae5;
  }
  .status-waiting_input {
    background: #92400e;
    color: #fef3c7;
  }
  .status-spawning,
  .status-idle {
    background: #1e3a8a;
    color: #dbeafe;
  }
  .status-exited,
  .status-crashed {
    background: #7f1d1d;
    color: #fecaca;
  }
</style>
