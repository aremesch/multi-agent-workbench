<script lang="ts">
  import { page } from '$app/state';
  import type { AgentCardRow, SidebarRepoNode } from '$lib/shared/types';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

  let {
    activeRepos,
    archivedRepos,
    collapsed
  }: {
    activeRepos: SidebarRepoNode[];
    archivedRepos: SidebarRepoNode[];
    collapsed: boolean;
  } = $props();

  let openRepos = $state<Record<string, boolean>>({});

  $effect(() => {
    const m = page.url.pathname.match(/^\/repos\/([^/]+)/);
    const id = m?.[1];
    if (id) openRepos[id] = true;
  });

  function toggleRepo(id: string): void {
    openRepos[id] = !openRepos[id];
  }
  function archiveHref(repoId: string): string {
    return `/repos/${repoId}/archive`;
  }
  function isArchiveActive(repoId: string): boolean {
    return page.url.pathname === `/repos/${repoId}/archive`;
  }

  function repoLabel(r: SidebarRepoNode): string {
    const tail = r.repoPath.split('/').filter(Boolean).pop() ?? r.repoPath;
    return tail;
  }

  function agentLabel(a: AgentCardRow): string {
    return a.task_title ? `${a.role_name} — ${a.task_title}` : a.role_name;
  }

  function repoHref(repoId: string): string {
    return `/repos/${repoId}`;
  }
  function agentHref(a: AgentCardRow): string {
    return `/repos/${a.repo_id}?agent=${a.id}`;
  }
  function isRepoActive(id: string): boolean {
    return page.url.pathname === `/repos/${id}`;
  }
  function isAgentActive(a: AgentCardRow): boolean {
    return (
      page.url.pathname === `/repos/${a.repo_id}` && page.url.searchParams.get('agent') === a.id
    );
  }
</script>

<aside class="sidebar" class:collapsed={collapsed}>
  {#if !collapsed}
    <nav class="tree">
      <div class="section-label">{t('sidebar.repositories')}</div>
      {#if activeRepos.length === 0}
        <div class="empty">{t('sidebar.noRepos')}</div>
      {:else}
        <ul class="list">
          {#each activeRepos as repo (repo.repoId)}
            <li>
              <div class="row" class:active={isRepoActive(repo.repoId)}>
                {#if repo.agents.length > 0}
                  <button
                    type="button"
                    class="disclosure"
                    class:open={openRepos[repo.repoId]}
                    aria-label={openRepos[repo.repoId] ? t('sidebar.collapse') : t('sidebar.expand')}
                    onclick={() => toggleRepo(repo.repoId)}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="currentColor" d="M9 6l6 6-6 6V6z" />
                    </svg>
                  </button>
                {:else}
                  <span class="disclosure spacer" aria-hidden="true"></span>
                {/if}
                <a
                  class="row-link"
                  href={repoHref(repo.repoId)}
                  title={repo.projectName ? `${repo.projectName} — ${repo.repoPath}` : repo.repoPath}
                >
                  <span class="label">{repoLabel(repo)}</span>
                  {#if repo.agents.length > 0}
                    <span class="count">{repo.agents.length}</span>
                  {/if}
                </a>
              </div>
              {#if openRepos[repo.repoId] && repo.agents.length > 0}
                <ul class="agents">
                  {#each repo.agents as agent (agent.id)}
                    <li>
                      <a
                        class="row-link agent"
                        class:active={isAgentActive(agent)}
                        href={agentHref(agent)}
                        title={agentLabel(agent)}
                      >
                        <span class="dot status-{agent.status}" aria-hidden="true"></span>
                        <span class="label">{agentLabel(agent)}</span>
                      </a>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <div class="section-label archive-label">
        {t('sidebar.archive')}
        <span class="count" style="margin-left: auto;"
          >{archivedRepos.reduce((n, r) => n + r.agents.length, 0)}</span
        >
      </div>
        {#if archivedRepos.length === 0}
          <div class="empty">{t('sidebar.noArchived')}</div>
        {:else}
          <ul class="list">
            {#each archivedRepos as repo (repo.repoId)}
              <li>
                <div class="row" class:active={isArchiveActive(repo.repoId)}>
                  <span class="disclosure spacer" aria-hidden="true"></span>
                  <a
                    class="row-link"
                    href={archiveHref(repo.repoId)}
                    title={repo.projectName ? `${repo.projectName} — ${repo.repoPath}` : repo.repoPath}
                  >
                    <span class="label">{repoLabel(repo)}</span>
                    <span class="count">{repo.agents.length}</span>
                  </a>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
    </nav>
  {/if}
</aside>

<style>
  .sidebar {
    width: 16rem;
    flex: 0 0 16rem;
    background: var(--md-sys-color-surface);
    border-right: 1px solid var(--md-sys-color-outline-variant);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: width var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
  }
  .sidebar.collapsed {
    width: 0;
    flex: 0 0 0;
    border-right: none;
  }
  .tree {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0.5rem 1rem;
  }
  .section-label {
    font-size: 0.7rem;
    font-weight: 500;
    color: var(--md-sys-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.75rem 0.5rem 0.25rem;
  }
  .archive-label {
    margin-top: 0.75rem;
    border-top: 1px solid var(--md-sys-color-outline-variant);
    padding-top: 0.75rem;
    display: flex;
    align-items: center;
  }
  ul.list,
  ul.agents {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  ul.agents {
    padding-left: 1.6rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.1rem;
    padding: 0;
  }
  .disclosure {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.75rem;
    background: transparent;
    border: none;
    color: var(--md-sys-color-on-surface-variant);
    cursor: pointer;
    padding: 0;
    transition: transform var(--md-sys-motion-duration-short)
      var(--md-sys-motion-easing-standard);
  }
  .disclosure.open {
    transform: rotate(90deg);
  }
  .disclosure.spacer {
    cursor: default;
    display: inline-block;
  }
  .row-link {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
    height: 2rem;
    padding: 0 0.75rem;
    color: var(--md-sys-color-on-surface);
    text-decoration: none;
    font-size: 0.85rem;
    border-radius: var(--md-sys-shape-corner-full);
    transition: background var(--md-sys-motion-duration-short)
      var(--md-sys-motion-easing-standard);
  }
  .row-link.agent {
    font-size: 0.8rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  .row-link:hover {
    background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
  }
  .row-link.active,
  .row.active > .row-link {
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
  }
  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    font-size: 0.7rem;
    color: var(--md-sys-color-on-surface-variant);
    background: var(--md-sys-color-surface-container-high);
    padding: 0.05rem 0.45rem;
    border-radius: var(--md-sys-shape-corner-full);
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex: 0 0 0.5rem;
    background: var(--md-sys-color-outline);
    box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 0%, transparent);
  }
  .dot.status-running {
    background: var(--md-sys-color-success);
  }
  .dot.status-waiting_input {
    background: var(--md-sys-color-warning);
  }
  .dot.status-spawning,
  .dot.status-idle {
    background: var(--md-sys-color-info);
  }
  .dot.status-exited {
    background: var(--md-sys-color-outline);
  }
  .dot.status-crashed {
    background: var(--md-sys-color-error);
  }
  .empty {
    padding: 0.5rem 0.75rem;
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.8rem;
    font-style: italic;
  }
</style>
