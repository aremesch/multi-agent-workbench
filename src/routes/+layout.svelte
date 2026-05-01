<script lang="ts">
  import { apiFetch } from '$lib/client/api';
  import '../app.css';
  import { onMount, setContext, type Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import RepoTreeSidebar from '$lib/client/components/RepoTreeSidebar.svelte';
  import AboutModal from '$lib/client/components/AboutModal.svelte';
  import AlertToastContainer from '$lib/client/components/AlertToastContainer.svelte';
  import type { SidebarRepoNode } from '$lib/shared/types';
  import type { ThemeId } from '$lib/shared/dashboard';
  import { getMawWsClient } from '$lib/client/ws';
  import { registerPush } from '$lib/client/push';
  import { initTheme } from '$lib/client/stores/theme';
  import { initLocale, currentLocale } from '$lib/client/stores/locale';
  import { t as translate, type Locale } from '$lib/i18n';

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
      locale: Locale;
      vapidPublicKey?: string;
      gitIdentitySet?: boolean;
    };
  } = $props();

  // Provide locale via context so descendant components can use useT().
  // svelte-ignore state_referenced_locally
  let locale = $state<Locale>(data.locale);
  setContext('maw-locale', () => locale);
  currentLocale.subscribe((v) => { locale = v; });

  function tt(key: string, params?: Record<string, string | number>): string {
    return translate(locale, key, params);
  }

  onMount(() => {
    initTheme(data.theme);
    initLocale(data.locale);
    // Kick off the shared ws connection as soon as the app hydrates so the
    // first modal open finds it already `OPEN` and the first subscribe
    // doesn't have to wait on the handshake.
    getMawWsClient();
    // Register push subscription if VAPID keys are configured.
    if (data.user && data.vapidPublicKey) {
      registerPush(data.vapidPublicKey).catch(() => {});
    }
  });

  // svelte-ignore state_referenced_locally
  let sidebarCollapsed = $state(data.sidebar?.collapsed ?? false);
  let menuOpen = $state(false);
  let aboutOpen = $state(false);

  async function toggleSidebar(): Promise<void> {
    sidebarCollapsed = !sidebarCollapsed;
    try {
      await apiFetch('/api/user/sidebar-state', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collapsed: sidebarCollapsed })
      });
    } catch {
      // Non-fatal — preference will revert on next page load.
    }
  }

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

  function gotoAccount(): void {
    closeMenu();
    void goto('/account');
  }

  function openAbout(): void {
    closeMenu();
    aboutOpen = true;
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

<div class="flex h-screen flex-col overflow-hidden bg-surface text-on-surface">
  <header
    class="flex items-center gap-3 border-b border-outline-variant bg-surface-container px-4 py-2.5"
  >
    {#if data.user && data.sidebar}
      <button
        type="button"
        class="sidebar-toggle inline-flex h-8 w-8 items-center justify-center rounded-full bg-transparent text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
        aria-label={sidebarCollapsed ? tt('nav.showSidebar') : tt('nav.hideSidebar')}
        onclick={toggleSidebar}
        style="transition: background var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          {#if sidebarCollapsed}
            <path fill="currentColor" d="M3 18h18v-2H3v2Zm0-5h18v-2H3v2Zm0-7v2h18V6H3Z" />
          {:else}
            <path fill="currentColor" d="M3 18h18v-2H3v2Zm0-5h18v-2H3v2Zm0-7v2h18V6H3Z" />
          {/if}
        </svg>
      </button>
    {/if}
    <a
      href="/"
      class="font-semibold text-on-surface no-underline hover:text-primary"
      style="transition: color var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);"
    >
      {tt('nav.appTitle')}
    </a>
    {#if data.user}
      <div class="menu-wrap relative ml-auto">
        <button
          type="button"
          class="user-btn flex items-center gap-1.5 rounded-full border-none bg-transparent px-2.5 py-1 text-sm text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          aria-label={tt('nav.userMenu')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onclick={toggleMenu}
          style="cursor: pointer; transition: background var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);"
        >
          {data.user.username}
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" class="chevron" class:open={menuOpen}>
            <path fill="currentColor" d="M7 10l5 5 5-5H7Z" />
          </svg>
        </button>
        {#if menuOpen}
          <div
            role="menu"
            class="absolute right-0 top-full z-50 mt-2 flex min-w-48 flex-col rounded-md border border-outline-variant bg-surface-container-high py-2"
            style="box-shadow: var(--md-sys-elevation-level-2);"
          >
            <button
              type="button"
              class="menu-item flex h-10 items-center gap-3 px-4 text-left text-sm text-on-surface hover:bg-surface-container-highest"
              role="menuitem"
              onclick={gotoSettings}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M19.14 12.94a7.49 7.49 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.14.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.67 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.33.67.23l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.25.25.43.49.43h3.84c.25 0 .45-.18.49-.42l.36-2.54c.59-.24 1.14-.56 1.63-.94l2.39.96c.24.1.53.01.67-.23l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z"
                />
              </svg>
              {tt('nav.settings')}
            </button>
            <button
              type="button"
              class="menu-item flex h-10 items-center gap-3 px-4 text-left text-sm text-on-surface hover:bg-surface-container-highest"
              role="menuitem"
              onclick={gotoAccount}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3.33 0-10 1.67-10 5v3h20v-3c0-3.33-6.67-5-10-5Z"
                />
              </svg>
              {tt('nav.account')}
            </button>
            <hr class="my-1 border-outline-variant" />
            <button
              type="button"
              class="menu-item flex h-10 items-center gap-3 px-4 text-left text-sm text-on-surface hover:bg-surface-container-highest"
              role="menuitem"
              onclick={openAbout}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm1 15h-2v-6h2Zm0-8h-2V7h2Z"
                />
              </svg>
              {tt('nav.about')}
            </button>
            <form method="POST" action="/login?/logout" class="m-0">
              <button
                type="submit"
                class="menu-item flex h-10 w-full items-center gap-3 px-4 text-left text-sm text-on-surface hover:bg-surface-container-highest"
                role="menuitem"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M17 7l-1.41 1.41L18.17 11H9v2h9.17l-2.58 2.59L17 17l5-5-5-5ZM5 5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7v-2H5V5Z"
                  />
                </svg>
                {tt('nav.logout')}
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
        collapsed={sidebarCollapsed}
      />
    {/if}
    <section class="min-w-0 flex-1 overflow-y-auto p-4">
      {#if data.user && data.gitIdentitySet === false}
        <aside class="git-identity-banner" role="status">
          <span class="banner-text">{tt('banner.gitIdentityUnset')}</span>
          <a class="banner-link" href="/settings#git">{tt('banner.gitIdentityAction')}</a>
        </aside>
      {/if}
      {@render children()}
    </section>
  </div>
</div>

<AboutModal open={aboutOpen} onClose={() => (aboutOpen = false)} />

{#if data.user}
  <AlertToastContainer />
{/if}

<style>
  .git-identity-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 1rem;
    margin-bottom: 1rem;
    background: var(--md-sys-color-tertiary-container);
    color: var(--md-sys-color-on-tertiary-container);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--md-sys-shape-corner-md);
    font-size: 0.9rem;
  }
  .banner-text {
    flex: 1 1 auto;
  }
  .banner-link {
    color: var(--md-sys-color-primary);
    text-decoration: underline;
    white-space: nowrap;
  }
</style>
