<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<header class="head">
  <h1>Dashboard</h1>
  <a href="/agents/new" class="cta">Spawn agent</a>
</header>

<div class="cards">
  <section class="card">
    <div class="card-head">
      <h2>Projects ({data.projects.length})</h2>
      <a href="/projects/new" class="btn">New</a>
    </div>
    {#if data.projects.length === 0}
      <p class="muted">No projects yet.</p>
    {:else}
      <ul>
        {#each data.projects as p (p.id)}
          <li>
            <a href={`/projects/${p.id}`}>{p.name}</a>
            <span class="muted"> — <code>{p.default_branch}</code></span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="card">
    <div class="card-head">
      <h2>Roles ({data.roles.length})</h2>
      <a href="/roles/new" class="btn">New</a>
    </div>
    {#if data.roles.length === 0}
      <p class="muted">No roles yet.</p>
    {:else}
      <ul>
        {#each data.roles as r (r.id)}
          <li>
            <a href="/roles">{r.name}</a>
            <span class="muted"> — <code>{r.cli_kind}</code></span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="card">
    <div class="card-head">
      <h2>Agents ({data.agents.length})</h2>
    </div>
    {#if data.agents.length === 0}
      <p class="muted">No agents yet.</p>
    {:else}
      <ul>
        {#each data.agents as a (a.id)}
          <li>
            <a href={`/agents/${a.id}`}>{a.cli_kind}</a>
            <span class="muted"> — <code>{a.status}</code></span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  h1 {
    margin: 0;
  }
  h2 {
    font-size: 1rem;
    color: #d1d5db;
    margin: 0;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: 1rem;
  }
  .card {
    background: #111;
    border: 1px solid #1f2937;
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .muted {
    color: #6b7280;
  }
  code {
    background: #1f2937;
    padding: 0.1em 0.35em;
    border-radius: 0.25em;
  }
  ul {
    padding-left: 1.25rem;
    margin: 0;
  }
  li {
    margin: 0.2rem 0;
  }
  a {
    color: #93c5fd;
  }
  .btn {
    padding: 0.25rem 0.6rem;
    border-radius: 0.375rem;
    background: #1f2937;
    border: 1px solid #374151;
    color: #e5e5e5;
    text-decoration: none;
    font-size: 0.8rem;
  }
  .cta {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    background: #2563eb;
    color: #fff;
    text-decoration: none;
    font-weight: 500;
  }
</style>
