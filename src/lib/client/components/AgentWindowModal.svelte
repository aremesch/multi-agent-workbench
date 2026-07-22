<script lang="ts">
  /**
   * Shared agent-terminal window: a Modal wrapping the live terminal, with
   * a captioned title bar, the kebab AgentMenu (Show Plan / Show Log / Exit)
   * and the Plan / Log / Exit-confirm sub-dialogs. Previously this pattern
   * was inlined only in `repos/[id]/+page.svelte`, so the queue's
   * "Open agent" link (→ bare `/agents/[id]`) had no caption and no way to
   * reach the plan/log. All three call sites now share this component.
   *
   * The parent owns *which* agent is shown (and any route-URL sync); this
   * component owns the terminal-status tracking and the plan/log/exit
   * sub-state. `onArchived` is the caller's hook for the terminal status
   * (repo page → invalidateAll, standalone route / queue → navigate away).
   */
  import { apiFetch } from '$lib/client/api';
  import { useT } from '$lib/client/i18n.svelte';
  import type { AgentStatus } from '$lib/shared/types';
  import { isCodingCliKind } from '$lib/shared/browserTarget';
  import Modal from './Modal.svelte';
  import AgentTerminalPanel from './AgentTerminalPanel.svelte';
  import AgentMenu from './AgentMenu.svelte';
  import PlanViewerModal from './PlanViewerModal.svelte';
  import ShowChangesModal from './ShowChangesModal.svelte';
  import ArchivedAgentLogModal from './ArchivedAgentLogModal.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';

  const t = useT();

  interface AgentWindowAgent {
    id: string;
    cli_kind: string;
    status: AgentStatus;
    tmux_session: string;
    target_url: string | null;
    role_name: string;
    task_title: string | null;
  }

  let {
    agent,
    open,
    onClose,
    onArchived
  }: {
    agent: AgentWindowAgent | null;
    open: boolean;
    onClose: () => void;
    /** Called when the agent reaches a terminal status (exited/crashed). */
    onArchived?: () => void;
  } = $props();

  let openAgentStatus = $state('');
  let planOpen = $state(false);
  let changesOpen = $state(false);
  let logOpen = $state(false);
  let exitConfirmOpen = $state(false);
  let exitErrorMsg = $state<string | null>(null);

  // Re-seed the status pill from the freshly-shown agent; the WS push via
  // AgentTerminalPanel.onStatusChange then drives it live afterwards.
  $effect(() => {
    openAgentStatus = agent?.status ?? '';
  });

  // Tear down the kebab-spawned sub-dialogs whenever the window closes so
  // they never linger over an empty backdrop (mirrors repos/[id] closeModal).
  $effect(() => {
    if (!open || !agent) {
      planOpen = false;
      changesOpen = false;
      logOpen = false;
      exitConfirmOpen = false;
      exitErrorMsg = null;
    }
  });

  $effect(() => {
    if (!agent) return;
    if (openAgentStatus === 'exited' || openAgentStatus === 'crashed') {
      onArchived?.();
    }
  });

  function openShowPlan(): void {
    exitErrorMsg = null;
    planOpen = true;
  }
  function openShowChanges(): void {
    exitErrorMsg = null;
    changesOpen = true;
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
    if (!agent) return;
    const id = agent.id;
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
</script>

{#snippet statusBadge()}
  {#if agent && isCodingCliKind(agent.cli_kind)}
    <AgentMenu
      agent={{
        id: agent.id,
        cli_kind: agent.cli_kind,
        status: (openAgentStatus || agent.status) as AgentStatus
      }}
      onShowPlan={openShowPlan}
      onShowChanges={openShowChanges}
      onShowLog={openShowLog}
      onExit={openExitConfirm}
    />
  {/if}
  <span class="status status-{openAgentStatus}">{openAgentStatus}</span>
{/snippet}

<Modal
  open={open && agent !== null}
  {onClose}
  title={agent
    ? `${agent.task_title ? `${agent.task_title} — ` : ''}${agent.role_name} — ${agent.cli_kind}`
    : ''}
  headerRight={openAgentStatus ? statusBadge : undefined}
>
  {#if agent}
    {#key agent.id}
      <AgentTerminalPanel
        agent={{
          id: agent.id,
          cli_kind: agent.cli_kind,
          status: agent.status,
          tmux_session: agent.tmux_session,
          target_url: agent.target_url
        }}
        onStatusChange={(s) => (openAgentStatus = s)}
      />
    {/key}
  {/if}
</Modal>

{#if planOpen}
  <PlanViewerModal
    open={planOpen}
    source={{ kind: 'agent', agentId: agent?.id ?? '' }}
    onClose={() => (planOpen = false)}
  />
{/if}

{#if changesOpen}
  <ShowChangesModal
    open={changesOpen}
    agentId={agent?.id ?? ''}
    onClose={() => (changesOpen = false)}
  />
{/if}

{#if logOpen}
  <ArchivedAgentLogModal
    open={logOpen}
    agentId={agent?.id ?? null}
    title={agent ? t('agent.logTitle', { name: agent.task_title ?? agent.id }) : ''}
    onClose={() => (logOpen = false)}
  />
{/if}

{#if exitConfirmOpen}
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
{/if}

{#if exitErrorMsg}
  <div class="exit-error" role="alert">
    {t('exitAgent.error', { error: exitErrorMsg })}
    <button type="button" class="exit-error-dismiss" onclick={() => (exitErrorMsg = null)}>
      {t('common.close')}
    </button>
  </div>
{/if}

<style>
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
