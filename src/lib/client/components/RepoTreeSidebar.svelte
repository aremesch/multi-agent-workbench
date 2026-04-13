<script lang="ts">
  import { page } from '$app/state';
  import type { AgentCardRow, SidebarRepoNode } from '$lib/shared/types';

  let {
    activeRepos,
    archivedRepos,
    collapsed
  }: {
    activeRepos: SidebarRepoNode[];
    archivedRepos: SidebarRepoNode[];
    collapsed: boolean;
  } = $props();

  // svelte-ignore state_referenced_locally
  let isCollapsed = $state(collapsed);
  let archiveOpen = $state(false);
  let openRepos = $state<Record<string, boolean>>({});
  let openArchiveRepos = $state<Record<string, boolean>>({});

  // Auto-expand the repo whose dashboard is currently shown so the user
  // can see the agents inside it without an extra click.
  $effect(() => {
    const m = page.url.pathname.match(/^\/repos\/([^/]+)/);
    const id = m?.[1];
    if (id) {
      openRepos[id] = true;
    }
  });

  async function toggleCollapsed(): Promise<void> {
    isCollapsed = !isCollapsed;
    try {
      await fetch('/api/user/sidebar-state', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collapsed: isCollapsed })
      });
    } catch {
      // Non-fatal — preference will revert on next page load.
    }
  }

  function toggleRepo(id: string): void {
    openRepos[id] = !openRepos[id];
  }
  function toggleArchiveRepo(id: string): void {
    openArchiveRepos[id] = !openArchiveRepos[id];
  }
  function toggleArchive(): void {
    archiveOpen = !archiveOpen;
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
</script>

<aside class="sidebar" class:collapsed={isCollapsed}>
  <header class="head">
    {#if !isCollapsed}
      <span class="title">Workspace</span>
    {/if}
    <button
      type="button"
      class="toggle"
      aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      onclick={toggleCollapsed}
    >
      {isCollapsed ? '›' : '‹'}
    </button>
  </header>

  {#if !isCollapsed}
    <nav class="tree">
      <div class="section-label">Repositories</div>
      {#if activeRepos.length === 0}
        <div class="empty">No repositories yet.</div>
      {:else}
        <ul class="list">
          {#each activeRepos as repo (repo.repoId)}
            <li>
              <div class="repo-row" class:active={isRepoActive(repo.repoId)}>
                {#if repo.agents.length > 0}
                  <button
                    type="button"
                    class="disclosure"
                    aria-label={openRepos[repo.repoId] ? 'Collapse' : 'Expand'}
                    onclick={() => toggleRepo(repo.repoId)}
                  >
                    {openRepos[repo.repoId] ? '▾' : '▸'}
                  </button>
                {:else}
                  <span class="disclosure spacer" aria-hidden="true"></span>
                {/if}
                <a
                  class="repo-link"
                  href={repoHref(repo.repoId)}
                  title={`${repo.projectName} — ${repo.repoPath}`}
                >
                  <span class="repo-name">{repoLabel(repo)}</span>
                  <span class="count">{repo.agents.length}</span>
                </a>
              </div>
              {#if openRepos[repo.repoId] && repo.agents.length > 0}
                <ul class="agents">
                  {#each repo.agents as agent (agent.id)}
                    <li>
                      <a class="agent-link" href={agentHref(agent)} title={agentLabel(agent)}>
                        <span class="dot status-{agent.status}"></span>
                        <span class="agent-name">{agentLabel(agent)}</span>
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
        <button type="button" class="archive-toggle" onclick={toggleArchive}>
          <span>{archiveOpen ? '▾' : '▸'}</span>
          <span>Archive</span>
          <span class="count">{archivedRepos.reduce((n, r) => n + r.agents.length, 0)}</span>
        </button>
      </div>
      {#if archiveOpen}
        {#if archivedRepos.length === 0}
          <div class="empty">No archived agents.</div>
        {:else}
          <ul class="list">
            {#each archivedRepos as repo (repo.repoId)}
              <li>
                <div class="repo-row">
                  <button
                    type="button"
                    class="disclosure"
                    aria-label={openArchiveRepos[repo.repoId] ? 'Collapse' : 'Expand'}
                    onclick={() => toggleArchiveRepo(repo.repoId)}
                  >
                    {openArchiveRepos[repo.repoId] ? '▾' : '▸'}
                  </button>
                  <a
                    class="repo-link"
                    href={repoHref(repo.repoId)}
                    title={`${repo.projectName} — ${repo.repoPath}`}
                  >
                    <span class="repo-name">{repoLabel(repo)}</span>
                    <span class="count">{repo.agents.length}</span>
                  </a>
                </div>
                {#if openArchiveRepos[repo.repoId]}
                  <ul class="agents">
                    {#each repo.agents as agent (agent.id)}
                      <li>
                        <a class="agent-link" href={agentHref(agent)} title={agentLabel(agent)}>
                          <span class="dot status-{agent.status}"></span>
                          <span class="agent-name">{agentLabel(agent)}</span>
                        </a>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </nav>
  {/if}
</aside>

<style>
  .sidebar {
    width: 16rem;
    flex: 0 0 16rem;
    background: #0a0a0a;
    border-right: 1px solid #1f2937;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .sidebar.collapsed {
    width: 1.75rem;
    flex: 0 0 1.75rem;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #1f2937;
    background: transparent;
    min-height: 2.25rem;
  }
  .sidebar.collapsed .head {
    padding: 0.25rem;
    justify-content: center;
  }
  .title {
    font-size: 0.8rem;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .toggle {
    background: transparent;
    border: 1px solid #374151;
    color: #d1d5db;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.25rem;
    cursor: pointer;
    line-height: 1;
    padding: 0;
  }
  .toggle:hover {
    background: #1f2937;
  }
  .tree {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
  }
  .section-label {
    font-size: 0.7rem;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.5rem 0.75rem 0.25rem;
  }
  .archive-label {
    margin-top: 0.5rem;
    border-top: 1px solid #1f2937;
    padding-top: 0.75rem;
  }
  .archive-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
    font: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    width: 100%;
  }
  .archive-toggle .count {
    margin-left: auto;
  }
  ul.list,
  ul.agents {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  ul.agents {
    padding-left: 1.25rem;
    margin-left: 0.6rem;
  }
  .repo-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.25rem;
  }
  .repo-row.active {
    background: #1f2937;
  }
  .disclosure {
    background: transparent;
    border: none;
    color: #9ca3af;
    cursor: pointer;
    width: 1.1rem;
    padding: 0;
    line-height: 1;
    font-size: 0.8rem;
  }
  .disclosure.spacer {
    cursor: default;
    display: inline-block;
  }
  .repo-link {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    color: #e5e7eb;
    text-decoration: none;
    font-size: 0.85rem;
    padding: 0.15rem 0.25rem;
    border-radius: 0.25rem;
  }
  .repo-link:hover {
    background: #1f2937;
  }
  .repo-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    font-size: 0.7rem;
    color: #9ca3af;
    background: #1f2937;
    padding: 0.05rem 0.4rem;
    border-radius: 0.5rem;
    margin-left: 0.4rem;
  }
  .agent-link {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: #d1d5db;
    text-decoration: none;
    padding: 0.2rem 0.4rem;
    border-radius: 0.25rem;
    font-size: 0.8rem;
    min-width: 0;
  }
  .agent-link:hover {
    background: #1f2937;
  }
  .agent-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    flex: 0 0 0.5rem;
    background: #4b5563;
  }
  .dot.status-running {
    background: #10b981;
  }
  .dot.status-waiting_input {
    background: #f59e0b;
  }
  .dot.status-spawning,
  .dot.status-idle {
    background: #3b82f6;
  }
  .dot.status-exited {
    background: #6b7280;
  }
  .dot.status-crashed {
    background: #ef4444;
  }
  .empty {
    padding: 0.4rem 0.9rem;
    color: #6b7280;
    font-size: 0.8rem;
    font-style: italic;
  }
</style>
