<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<h1>Dashboard</h1>

<section>
  <h2>Projects ({data.projects.length})</h2>
  {#if data.projects.length === 0}
    <p class="muted">No projects yet.</p>
  {:else}
    <ul>
      {#each data.projects as p (p.id)}
        <li>{p.name} — default branch <code>{p.default_branch}</code></li>
      {/each}
    </ul>
  {/if}
</section>

<section>
  <h2>Agents ({data.agents.length})</h2>
  {#if data.agents.length === 0}
    <p class="muted">No agents yet.</p>
  {:else}
    <ul>
      {#each data.agents as a (a.id)}
        <li>
          <a href={`/agents/${a.id}`}>{a.cli_kind}</a>
          — status <code>{a.status}</code>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  h1 {
    margin-top: 0;
  }
  h2 {
    font-size: 1.1rem;
    color: #d1d5db;
  }
  .muted {
    color: #6b7280;
  }
  code {
    background: #1f2937;
    padding: 0.1em 0.35em;
    border-radius: 0.25em;
  }
  a {
    color: #93c5fd;
  }
</style>
