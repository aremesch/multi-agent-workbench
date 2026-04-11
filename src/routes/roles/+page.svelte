<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<header class="head">
  <h1>Roles</h1>
  <a href="/roles/new" class="btn">New role</a>
</header>

{#if data.roles.length === 0}
  <p class="muted">No roles yet. A role bundles a CLI adapter + system prompt.</p>
{:else}
  <ul>
    {#each data.roles as r (r.id)}
      <li>
        <strong>{r.name}</strong>
        <code>{r.cli_kind}</code>
      </li>
    {/each}
  </ul>
{/if}

<p><a href="/" class="muted">← Back to dashboard</a></p>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h1 {
    margin: 0;
  }
  .muted {
    color: #6b7280;
  }
  code {
    background: #1f2937;
    padding: 0.1em 0.35em;
    border-radius: 0.25em;
    margin-left: 0.5rem;
  }
  ul {
    padding-left: 1.25rem;
  }
  li {
    margin: 0.25rem 0;
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
