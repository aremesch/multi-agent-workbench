<script lang="ts">
  import { invalidateAll, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import type { PageData } from './$types';
  import type { AgentCardRow, LayoutEntry } from '$lib/shared/types';
  import AgentGrid from '$lib/client/components/AgentGrid.svelte';
  import AgentTerminalPanel from '$lib/client/components/AgentTerminalPanel.svelte';
  import Modal from '$lib/client/components/Modal.svelte';
  import SpawnAgentForm from '$lib/client/components/SpawnAgentForm.svelte';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let { data }: { data: PageData } = $props();

  let openAgent = $state<AgentCardRow | null>(null);
  let openAgentStatus = $state<string>('');
  let spawnOpen = $state(false);

  function onOpen(agent: AgentCardRow): void {
    openAgent = agent;
    openAgentStatus = agent.status;
    syncAgentParam(agent.id);
  }
  function closeModal(): void {
    openAgent = null;
    openAgentStatus = '';
    syncAgentParam(null);
  }

  function syncAgentParam(id: string | null): void {
    const url = new URL(page.url);
    if (id) url.searchParams.set('agent', id);
    else url.searchParams.delete('agent');
    if (url.toString() !== page.url.toString()) {
      void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
    }
  }

  // Open the modal automatically when the URL carries ?agent=<id> — both
  // on first mount and on later sidebar clicks that change the param while
  // we're already on this page.
  //
  // `untrack` around `openAgent` reads ensures this effect fires ONLY when
  // the URL changes, not when `openAgent` is set directly (e.g. by onOpen).
  // Without it, setting openAgent triggers the effect before goto() has
  // updated the URL → the effect sees no ?agent= param and immediately
  // closes the modal that was just opened.
  $effect(() => {
    const wantId = page.url.searchParams.get('agent');
    if (!wantId) {
      if (untrack(() => openAgent)) {
        openAgent = null;
        openAgentStatus = '';
      }
      return;
    }
    if (untrack(() => openAgent)?.id === wantId) return;
    const match = (data.liveAgents as AgentCardRow[]).find((a) => a.id === wantId);
    if (match) {
      openAgent = match;
      openAgentStatus = match.status;
    }
  });

  $effect(() => {
    if (!openAgent) return;
    if (openAgentStatus === 'exited' || openAgentStatus === 'crashed') {
      void invalidateAll();
    }
  });

  async function saveLayout(layout: LayoutEntry[]): Promise<void> {
    try {
      await fetch('/api/user/dashboard-layout', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: data.layoutKey, layout })
      });
    } catch {
      // Non-fatal — layout will rebuild from defaults next load.
    }
  }

  function spawnAgent(): void {
    spawnOpen = true;
  }

  async function onSpawnSuccess(agentId: string): Promise<void> {
    spawnOpen = false;
    await invalidateAll();
    const fresh = (data.liveAgents as AgentCardRow[]).find((a) => a.id === agentId);
    if (fresh) {
      onOpen(fresh);
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

{#snippet statusBadge()}
  <span class="status status-{openAgentStatus}">{openAgentStatus}</span>
{/snippet}

<Modal
  open={openAgent !== null}
  onClose={closeModal}
  title={openAgent
    ? `${openAgent.project_name}${openAgent.task_title ? `/${openAgent.task_title}` : ''} — ${openAgent.role_name} — ${openAgent.cli_kind}`
    : ''}
  headerRight={openAgentStatus ? statusBadge : undefined}
>
  {#if openAgent}
    {#key openAgent.id}
      <AgentTerminalPanel
        agent={{
          id: openAgent.id,
          cli_kind: openAgent.cli_kind,
          status: openAgent.status,
          tmux_session: openAgent.tmux_session
        }}
        onStatusChange={(s) => (openAgentStatus = s)}
      />
    {/key}
  {/if}
</Modal>

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
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    border: none;
    font-size: 1.75rem;
    cursor: pointer;
    box-shadow: 0 6px 18px color-mix(in srgb, var(--md-sys-color-primary) 45%, transparent);
    z-index: 30;
  }
  .fab:hover {
    background: color-mix(in srgb, var(--md-sys-color-primary) 85%, black);
  }
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
