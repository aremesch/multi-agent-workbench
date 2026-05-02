<script lang="ts">
  /**
   * Kebab (three-dot) popup menu for the agent terminal modal header.
   * Mirrors the hamburger menu pattern in src/routes/+layout.svelte:
   * a button with `aria-haspopup="menu"` toggles an absolute-positioned
   * `<div role="menu">` containing `role="menuitem"` buttons. A global
   * window click + keydown listener closes the menu on outside click /
   * Escape.
   *
   * Caller is responsible for gating the whole component on coding-agent
   * cli kinds (see `isCodingCliKind` in $lib/shared/browserTarget). This
   * component only handles the per-item enable/disable logic — Exit
   * Agent is disabled once the agent has already exited or crashed.
   */

  import { useT } from '$lib/client/i18n.svelte';
  import type { AgentStatus } from '$lib/shared/types';

  const t = useT();

  let {
    agent,
    onShowPlan,
    onShowLog,
    onExit
  }: {
    agent: { id: string; cli_kind: string; status: AgentStatus };
    onShowPlan: () => void;
    onShowLog: () => void;
    onExit: () => void;
  } = $props();

  let menuOpen = $state(false);
  let buttonEl: HTMLButtonElement | undefined = $state();

  const isArchived = $derived(agent.status === 'exited' || agent.status === 'crashed');

  function toggleMenu(): void {
    menuOpen = !menuOpen;
  }
  function closeMenu(): void {
    menuOpen = false;
  }
  function pick(handler: () => void, disabled = false): () => void {
    return () => {
      if (disabled) return;
      closeMenu();
      handler();
    };
  }
  function onDocClick(ev: MouseEvent): void {
    if (!menuOpen) return;
    const target = ev.target as HTMLElement | null;
    if (target && target.closest('.agent-menu-wrap')) return;
    closeMenu();
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && menuOpen) {
      closeMenu();
      buttonEl?.focus();
    }
  }
</script>

<svelte:window onclick={onDocClick} onkeydown={onKey} />

<div class="agent-menu-wrap relative">
  <button
    type="button"
    bind:this={buttonEl}
    class="kebab-btn"
    aria-label={t('agentMenu.button')}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    onclick={toggleMenu}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"
      />
    </svg>
  </button>
  {#if menuOpen}
    <div
      role="menu"
      class="agent-menu"
      style="box-shadow: var(--md-sys-elevation-level-2);"
    >
      <button
        type="button"
        class="menu-item"
        role="menuitem"
        onclick={pick(onShowPlan)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 7V3.5L19.5 9H14ZM8 13h8v2H8v-2Zm0 4h5v2H8v-2Z"
          />
        </svg>
        {t('agentMenu.showPlan')}
      </button>
      <button
        type="button"
        class="menu-item"
        role="menuitem"
        onclick={pick(onShowLog)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 14H4V8h16v10ZM6 10l4 3-4 3v-6Zm6 4h6v2h-6v-2Z"
          />
        </svg>
        {t('agentMenu.showLog')}
      </button>
      <hr class="my-1 border-outline-variant" />
      <button
        type="button"
        class="menu-item destructive"
        role="menuitem"
        aria-disabled={isArchived}
        disabled={isArchived}
        onclick={pick(onExit, isArchived)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M13 3h-2v10h2V3Zm5.83 2.17l-1.42 1.42A6.96 6.96 0 0 1 19 12a7 7 0 1 1-12.41-4.42L5.17 6.17A9 9 0 1 0 21 12a8.97 8.97 0 0 0-2.17-5.83Z"
          />
        </svg>
        {t('agentMenu.exitAgent')}
      </button>
    </div>
  {/if}
</div>

<style>
  .agent-menu-wrap {
    display: inline-flex;
  }
  .kebab-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: none;
    border-radius: 9999px;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
    padding: 0;
    transition: background var(--md-sys-motion-duration-short, 150ms)
        var(--md-sys-motion-easing-standard, ease),
      color var(--md-sys-motion-duration-short, 150ms)
        var(--md-sys-motion-easing-standard, ease);
  }
  .kebab-btn:hover,
  .kebab-btn:focus-visible {
    background: #1f2937;
    color: #f3f4f6;
    outline: none;
  }
  .agent-menu {
    position: absolute;
    right: 0;
    top: 100%;
    margin-top: 0.5rem;
    z-index: 50;
    min-width: 12rem;
    display: flex;
    flex-direction: column;
    background: #111827;
    border: 1px solid #1f2937;
    border-radius: 0.375rem;
    padding: 0.25rem 0;
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    height: 2.25rem;
    padding: 0 0.875rem;
    text-align: left;
    font-size: 0.875rem;
    color: #e5e7eb;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background var(--md-sys-motion-duration-short, 150ms)
      var(--md-sys-motion-easing-standard, ease);
  }
  .menu-item:hover:not(:disabled),
  .menu-item:focus-visible:not(:disabled) {
    background: #1f2937;
    outline: none;
  }
  .menu-item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .menu-item.destructive {
    color: #fca5a5;
  }
  .menu-item.destructive:hover:not(:disabled),
  .menu-item.destructive:focus-visible:not(:disabled) {
    background: #7f1d1d;
    color: #fef2f2;
  }
  hr {
    margin: 0.25rem 0;
    border: none;
    border-top: 1px solid #1f2937;
  }
</style>
