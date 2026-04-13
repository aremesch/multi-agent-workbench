<script lang="ts">
  import '../app.css';
  import { onMount, type Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import RepoTreeSidebar from '$lib/client/components/RepoTreeSidebar.svelte';
  import type { SidebarRepoNode } from '$lib/shared/types';
  import type { ThemeId } from '$lib/shared/dashboard';
  import { getMawWsClient } from '$lib/client/ws';
  import { initTheme } from '$lib/client/stores/theme';

  let {
    children,
    data
  }: {
    children: Snippet;
    data: {
      user: { username: string } | null;
      sidebar: {
        activeRepos: SidebarRepoNode[];
        archivedRepos: SidebarRepoNode[];
        collapsed: boolean;
      } | null;
      theme: ThemeId;
    };
  } = $props();

  onMount(() => {
    initTheme(data.theme);
    // Kick off the shared ws connection as soon as the app hydrates so the
    // first modal open finds it already `OPEN` and the first subscribe
    // doesn't have to wait on the handshake.
    getMawWsClient();
  });

  let menuOpen = $state(false);

  function toggleMenu(): void {
    menuOpen = !menuOpen;
  }
  function closeMenu(): void {
    menuOpen = false;
  }

  function gotoSettings(): void {
    closeMenu();
    void goto('/settings');
  }

  function onDocClick(ev: MouseEvent): void {
    if (!menuOpen) return;
    const target = ev.target as HTMLElement | null;
    if (target && target.closest('.menu-wrap')) return;
    closeMenu();
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') closeMenu();
  }
</script>

<svelte:window onclick={onDocClick} onkeydown={onKey} />

<div class="flex min-h-screen flex-col bg-surface text-on-surface">
  <header
    class="flex items-center gap-3 border-b border-outline-variant bg-surface-container px-4 py-2.5"
  >
    <a
      href="/"
      class="font-semibold text-on-surface no-underline hover:text-primary"
      style="transition: color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);"
    >
      Multi-Agent Workbench
    </a>
    {#if data.user}
      <span class="ml-auto text-sm text-on-surface-variant">{data.user.username}</span>
      <div class="menu-wrap relative">
        <button
          type="button"
          class="hamburger inline-flex h-10 w-10 items-center justify-center rounded-full bg-transparent text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          aria-label="Open menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onclick={toggleMenu}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M4 7h16a1 1 0 1 1 0 2H4a1 1 0 1 1 0-2Zm0 4h16a1 1 0 1 1 0 2H4a1 1 0 1 1 0-2Zm0 4h16a1 1 0 1 1 0 2H4a1 1 0 1 1 0-2Z"
            />
          </svg>
        </button>
        {#if menuOpen}
          <div
            role="menu"
            class="absolute right-0 top-full z-50 mt-2 flex min-w-56 flex-col rounded-md border border-outline-variant bg-surface-container-high py-2"
            style="box-shadow: var(--md-sys-elevation-level-2);"
          >
            <button
              type="button"
              class="menu-item flex h-12 items-center gap-3 px-4 text-left text-sm text-on-surface hover:bg-surface-container-highest"
              role="menuitem"
              onclick={gotoSettings}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.14.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.67 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.33.67.23l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.25.25.43.49.43h3.84c.25 0 .45-.18.49-.42l.36-2.54c.59-.24 1.14-.56 1.63-.94l2.39.96c.24.1.53.01.67-.23l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z"
                />
              </svg>
              Settings
            </button>
            <form method="POST" action="/login?/logout" class="m-0">
              <button
                type="submit"
                class="menu-item flex h-12 w-full items-center gap-3 px-4 text-left text-sm text-on-surface hover:bg-surface-container-highest"
                role="menuitem"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M17 7l-1.41 1.41L18.17 11H9v2h9.17l-2.58 2.59L17 17l5-5-5-5ZM5 5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7v-2H5V5Z"
                  />
                </svg>
                Logout
              </button>
            </form>
          </div>
        {/if}
      </div>
    {/if}
  </header>
  <div class="flex min-h-0 flex-1">
    {#if data.user && data.sidebar}
      <RepoTreeSidebar
        activeRepos={data.sidebar.activeRepos}
        archivedRepos={data.sidebar.archivedRepos}
        collapsed={data.sidebar.collapsed}
      />
    {/if}
    <section class="min-w-0 flex-1 p-4">
      {@render children()}
    </section>
  </div>
</div>
