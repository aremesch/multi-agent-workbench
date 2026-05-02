<script lang="ts">
  import { apiFetch } from '$lib/client/api';
  import { invalidateAll, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import type { PageData } from './$types';
  import type { AgentCardRow, AgentStatus, LayoutEntry } from '$lib/shared/types';
  import AgentGrid from '$lib/client/components/AgentGrid.svelte';
  import AgentTerminalPanel from '$lib/client/components/AgentTerminalPanel.svelte';
  import Modal from '$lib/client/components/Modal.svelte';
  import SpawnAgentForm from '$lib/client/components/SpawnAgentForm.svelte';
  import AgentMenu from '$lib/client/components/AgentMenu.svelte';
  import PlanViewerModal from '$lib/client/components/PlanViewerModal.svelte';
  import ConfirmDialog from '$lib/client/components/ConfirmDialog.svelte';
  import ArchivedAgentLogModal from '$lib/client/components/ArchivedAgentLogModal.svelte';
  import { isCodingCliKind } from '$lib/shared/browserTarget';
  import { dismissToastsForAgent } from '$lib/client/stores/alertToasts';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  /**
   * Fire-and-forget: ack any unacked alerts for the agent the user just
   * opened, and clear matching foreground toasts. Runs every time the
   * `?agent=` effect resolves, including when the user switches between
   * agents inside the same dashboard view. Failures are silent — the
   * route is idempotent and a network blip shouldn't block the modal.
   */
  function ackAgentAlerts(agentId: string): void {
    dismissToastsForAgent(agentId);
    apiFetch(`/api/agents/${encodeURIComponent(agentId)}/alerts/ack`, {
      method: 'POST'
    }).catch(() => {});
  }

  let { data }: { data: PageData } = $props();

  let openAgent = $state<AgentCardRow | null>(null);
  let openAgentStatus = $state<string>('');
  let spawnOpen = $state(false);

  // Agent-window kebab menu modals — only relevant for coding CLI kinds.
  let planOpen = $state(false);
  let logOpen = $state(false);
  let exitConfirmOpen = $state(false);
  let exitErrorMsg = $state<string | null>(null);

  function openShowPlan(): void {
    exitErrorMsg = null;
    planOpen = true;
  }
  function openShowLog(): void {
    exitErrorMsg = null;
    logOpen = true;
  }
  function openExitConfirm(): void {
    exitErrorMsg = null;
    exitConfirmOpen = true;
  }

  async function confirmExitAgent(): Promise<void> {
    if (!openAgent) return;
    const id = openAgent.id;
    exitConfirmOpen = false;
    try {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(id)}/stop`, {
        method: 'POST'
      });
      // 409 (already_archived) is a no-op success — the WS state push will
      // settle the badge to `exited` either way.
      if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      exitErrorMsg = err instanceof Error ? err.message : String(err);
    }
  }

  function onOpen(agent: AgentCardRow): void {
    openAgent = agent;
    openAgentStatus = agent.status;
    syncAgentParam(agent.id);
    ackAgentAlerts(agent.id);
  }
  function closeModal(): void {
    openAgent = null;
    openAgentStatus = '';
    // Close any kebab-spawned dialogs alongside the parent modal so they
    // never linger over a now-empty backdrop.
    planOpen = false;
    logOpen = false;
    exitConfirmOpen = false;
    exitErrorMsg = null;
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
      // Deep-link land (push notification, sidebar click) — same ack/toast
      // dismissal as the in-app onOpen path so foreground UX converges.
      ackAgentAlerts(match.id);
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
      await apiFetch('/api/user/dashboard-layout', {
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
  {#if openAgent && isCodingCliKind(openAgent.cli_kind)}
    <AgentMenu
      agent={{
        id: openAgent.id,
        cli_kind: openAgent.cli_kind,
        status: (openAgentStatus || openAgent.status) as AgentStatus
      }}
      onShowPlan={openShowPlan}
      onShowLog={openShowLog}
      onExit={openExitConfirm}
    />
  {/if}
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
          tmux_session: openAgent.tmux_session,
          target_url: openAgent.target_url
        }}
        onStatusChange={(s) => (openAgentStatus = s)}
      />
    {/key}
  {/if}
</Modal>

<PlanViewerModal
  open={planOpen}
  agentId={openAgent?.id ?? null}
  onClose={() => (planOpen = false)}
/>

<ArchivedAgentLogModal
  open={logOpen}
  agentId={openAgent?.id ?? null}
  title={openAgent ? t('agent.logTitle', { name: openAgent.task_title ?? openAgent.id }) : ''}
  onClose={() => (logOpen = false)}
/>

<ConfirmDialog
  open={exitConfirmOpen}
  title={t('exitAgent.confirm.title')}
  body={t('exitAgent.confirm.body')}
  confirmLabel={t('exitAgent.confirm.confirm')}
  cancelLabel={t('exitAgent.confirm.cancel')}
  tone="destructive"
  onConfirm={confirmExitAgent}
  onCancel={() => (exitConfirmOpen = false)}
/>

{#if exitErrorMsg}
  <div class="exit-error" role="alert">
    {t('exitAgent.error', { error: exitErrorMsg })}
    <button type="button" class="exit-error-dismiss" onclick={() => (exitErrorMsg = null)}>
      {t('common.close')}
    </button>
  </div>
{/if}

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
  .exit-error {
    position: fixed;
    bottom: 1.25rem;
    left: 50%;
    transform: translateX(-50%);
    background: #7f1d1d;
    color: #fecaca;
    padding: 0.6rem 1rem;
    border-radius: 0.375rem;
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.875rem;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  }
  .exit-error-dismiss {
    background: transparent;
    border: 1px solid #fecaca;
    color: #fecaca;
    padding: 0.2rem 0.55rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .exit-error-dismiss:hover {
    background: rgba(254, 202, 202, 0.15);
  }
</style>
