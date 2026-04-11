<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import type { AgentCardRow } from '$lib/shared/types';
  import AgentArchiveDrawer from '$lib/client/components/AgentArchiveDrawer.svelte';

  let { children, data }: { children: Snippet; data: { user: { username: string } | null } } =
    $props();

  let menuOpen = $state(false);
  let drawerOpen = $state(false);

  // Archived agents are loaded by the dashboard page's load function. On
  // other routes this will simply be undefined/empty, which hides the count
  // and leaves the drawer empty if the user opens it.
  const archivedAgents = $derived<AgentCardRow[]>(
    ((page.data as { archivedAgents?: AgentCardRow[] }).archivedAgents ?? []) as AgentCardRow[]
  );

  function toggleMenu(): void {
    menuOpen = !menuOpen;
  }

  function closeMenu(): void {
    menuOpen = false;
  }

  function openArchive(): void {
    drawerOpen = true;
    menuOpen = false;
  }

  // Close the dropdown on outside click / Escape.
  function onDocClick(ev: MouseEvent): void {
    if (!menuOpen) return;
    const target = ev.target as HTMLElement | null;
    if (target && target.closest('.menu-wrap')) return;
    closeMenu();
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      closeMenu();
    }
  }
</script>

<svelte:window onclick={onDocClick} onkeydown={onKey} />

<main class="app">
  <header class="topbar">
    <a href="/" class="brand">Multi-Agent Workbench</a>
    {#if data.user}
      <span class="user">{data.user.username}</span>
      <div class="menu-wrap">
        <button
          type="button"
          class="hamburger"
          aria-label="Open menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onclick={toggleMenu}
        >
          <span class="bar"></span>
          <span class="bar"></span>
          <span class="bar"></span>
        </button>
        {#if menuOpen}
          <div class="menu" role="menu">
            <button type="button" class="menu-item" role="menuitem" onclick={openArchive}>
              Archive ({archivedAgents.length})
            </button>
            <form method="POST" action="/login?/logout" class="menu-form">
              <button type="submit" class="menu-item" role="menuitem">Logout</button>
            </form>
          </div>
        {/if}
      </div>
    {/if}
  </header>
  <section class="content">
    {@render children()}
  </section>
</main>

{#if data.user}
  <AgentArchiveDrawer
    open={drawerOpen}
    onClose={() => (drawerOpen = false)}
    {archivedAgents}
  />
{/if}

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    background: #0a0a0a;
  }
  .app {
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #e5e5e5;
    background: #0a0a0a;
    min-height: 100vh;
  }
  .topbar {
    display: flex;
    align-items: center;
    padding: 0.75rem 1rem;
    background: #111;
    border-bottom: 1px solid #222;
    gap: 0.75rem;
  }
  .brand {
    font-weight: 600;
    color: #e5e5e5;
    text-decoration: none;
  }
  .user {
    margin-left: auto;
    font-size: 0.9rem;
    color: #9ca3af;
  }
  .menu-wrap {
    position: relative;
  }
  .hamburger {
    display: inline-flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 3px;
    width: 2rem;
    height: 2rem;
    padding: 0;
    background: #1f2937;
    color: #e5e5e5;
    border: 1px solid #374151;
    border-radius: 0.375rem;
    cursor: pointer;
  }
  .hamburger:hover {
    background: #374151;
  }
  .hamburger .bar {
    display: block;
    width: 1rem;
    height: 2px;
    background: currentColor;
    border-radius: 1px;
  }
  .menu {
    position: absolute;
    top: calc(100% + 0.35rem);
    right: 0;
    min-width: 12rem;
    background: #111827;
    border: 1px solid #1f2937;
    border-radius: 0.5rem;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    padding: 0.25rem;
    z-index: 50;
    display: flex;
    flex-direction: column;
  }
  .menu-form {
    margin: 0;
  }
  .menu-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.5rem 0.75rem;
    background: transparent;
    color: #e5e7eb;
    border: none;
    border-radius: 0.375rem;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .menu-item:hover {
    background: #1f2937;
  }
  .content {
    padding: 1rem;
  }
</style>
