<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<header class="head">
  <h1>{data.project.name}</h1>
  <span class="muted">default branch <code>{data.project.default_branch}</code></span>
</header>

<section>
  <div class="section-head">
    <h2>Repositories ({data.repos.length})</h2>
    <a href={`/projects/${data.project.id}/repos/new`} class="btn">New repo</a>
  </div>
  {#if data.repos.length === 0}
    <p class="muted">No repos attached yet.</p>
  {:else}
    <ul>
      {#each data.repos as r (r.id)}
        <li>
          <code>{r.path}</code>
          {#if r.origin_url}
            <span class="muted"> — {r.origin_url}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<p><a href="/" class="muted">← Back to dashboard</a></p>

<style>
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }
  h1 {
    margin: 0;
  }
  h2 {
    font-size: 1.1rem;
    color: #d1d5db;
    margin: 0;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 1.5rem;
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
  }
  .btn {
    padding: 0.4rem 0.75rem;
    border-radius: 0.375rem;
    background: #2563eb;
    color: #fff;
    text-decoration: none;
    font-size: 0.85rem;
  }
  a {
    color: #93c5fd;
  }
</style>
