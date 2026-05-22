<script lang="ts">
  /**
   * Kebab (three-dot) popup menu for the agent terminal modal header.
   * Thin wrapper over the generic {@link OverflowMenu}: it only maps the
   * agent-window actions (Show Plan / Show Log / Exit) to menu items and
   * gates Exit Agent once the agent has already exited or crashed.
   *
   * Caller is responsible for gating the whole component on coding-agent
   * cli kinds (see `isCodingCliKind` in $lib/shared/browserTarget).
   *
   * The public prop signature is intentionally unchanged from the original
   * hand-rolled menu so existing consumers and AgentMenu.test.ts need no
   * edits — that test is the behavioural parity gate for OverflowMenu.
   */

  import { useT } from '$lib/client/i18n.svelte';
  import { isCodingCliKind } from '$lib/shared/browserTarget';
  import type { AgentStatus } from '$lib/shared/types';
  import OverflowMenu, { type OverflowMenuItem } from './OverflowMenu.svelte';

  const t = useT();

  let {
    agent,
    onShowPlan,
    onShowLog,
    onExit,
    showExit = true
  }: {
    agent: { id: string; cli_kind: string; status: AgentStatus };
    onShowPlan: () => void;
    onShowLog: () => void;
    /** Required only when `showExit` is true; ignored otherwise. */
    onExit?: () => void;
    /** Set to `false` in surfaces where the agent is always already exited
        (e.g. archive view) so the perma-disabled Exit row is hidden. */
    showExit?: boolean;
  } = $props();

  const isArchived = $derived(agent.status === 'exited' || agent.status === 'crashed');
  // Plans are a coding-agent concept; for browser/shell kinds disable the
  // row so the kebab can still surface Show Log uniformly.
  const planDisabled = $derived(!isCodingCliKind(agent.cli_kind));

  const items: OverflowMenuItem[] = $derived([
    {
      id: 'plan',
      label: t('agentMenu.showPlan'),
      icon: planIcon,
      onSelect: onShowPlan,
      disabled: planDisabled
    },
    {
      id: 'log',
      label: t('agentMenu.showLog'),
      icon: logIcon,
      onSelect: onShowLog
    },
    ...(showExit
      ? [
          {
            id: 'exit',
            label: t('agentMenu.exitAgent'),
            icon: exitIcon,
            onSelect: onExit,
            dividerBefore: true,
            destructive: true,
            disabled: isArchived
          } satisfies OverflowMenuItem
        ]
      : [])
  ]);
</script>

{#snippet planIcon()}
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 7V3.5L19.5 9H14ZM8 13h8v2H8v-2Zm0 4h5v2H8v-2Z"
    />
  </svg>
{/snippet}

{#snippet logIcon()}
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 14H4V8h16v10ZM6 10l4 3-4 3v-6Zm6 4h6v2h-6v-2Z"
    />
  </svg>
{/snippet}

{#snippet exitIcon()}
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M13 3h-2v10h2V3Zm5.83 2.17l-1.42 1.42A6.96 6.96 0 0 1 19 12a7 7 0 1 1-12.41-4.42L5.17 6.17A9 9 0 1 0 21 12a8.97 8.97 0 0 0-2.17-5.83Z"
    />
  </svg>
{/snippet}

<OverflowMenu {items} label={t('agentMenu.button')} align="end" />
