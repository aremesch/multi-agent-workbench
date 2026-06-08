<script lang="ts">
  import { apiFetch } from '$lib/client/api';
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';
  import type { AgentCardRow, LayoutEntry } from '$lib/shared/types';
  import AgentGrid from '$lib/client/components/AgentGrid.svelte';
  import Modal from '$lib/client/components/Modal.svelte';
  import SpawnAgentForm from '$lib/client/components/SpawnAgentForm.svelte';
  import AgentWindowModal from '$lib/client/components/AgentWindowModal.svelte';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let { data }: { data: PageData } = $props();

  let openAgent = $state<AgentCardRow | null>(null);
  let spawnOpen = $state(false);

  function onOpen(agent: AgentCardRow): void {
    openAgent = agent;
  }
  function closeModal(): void {
    openAgent = null;
  }

  // Auto-close the terminal modal and refresh the grid when the underlying
  // agent ends — same UX as an ssh session, where Ctrl-D twice closes the
  // window. AgentWindowModal fires `onArchived` on the live → exited/crashed
  // transition; invalidateAll() then drops the card from the grid and lands
  // it in the archive drawer without a manual refresh.
  function onAgentArchived(): void {
    closeModal();
    void invalidateAll();
  }

  async function saveLayout(layout: LayoutEntry[]): Promise<void> {
    try {
      await apiFetch('/api/user/dashboard-layout', {
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

<button type="button" class="fab" aria-label={t('agent.spawnAgent')} onclick={spawnAgent}>
  <span aria-hidden="true">+</span>
</button>

<AgentWindowModal
  agent={openAgent}
  open={openAgent !== null}
  onClose={closeModal}
  onArchived={onAgentArchived}
/>

<Modal open={spawnOpen} onClose={() => (spawnOpen = false)} title={t('spawn.title')}>
  {#if spawnOpen}
    <SpawnAgentForm
      roles={data.spawnRoles}
      repos={data.spawnRepos}
      cliKinds={data.spawnCliKinds}
      spawnDefaults={data.spawnDefaults}
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
</style>
