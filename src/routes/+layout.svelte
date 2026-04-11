<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children, data }: { children: Snippet; data: { user: { username: string } | null } } = $props();
</script>

<main class="app">
  <header class="topbar">
    <a href="/" class="brand">Multi-Agent Workbench</a>
    {#if data.user}
      <span class="user">{data.user.username}</span>
      <form method="post" action="/login?/logout" class="inline">
        <button type="submit">Logout</button>
      </form>
    {/if}
  </header>
  <section class="content">
    {@render children()}
  </section>
</main>

<style>
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
  .inline {
    display: inline;
  }
  .content {
    padding: 1rem;
  }
  button {
    background: #1f2937;
    color: #e5e5e5;
    border: 1px solid #374151;
    padding: 0.35rem 0.75rem;
    border-radius: 0.375rem;
    cursor: pointer;
  }
</style>
