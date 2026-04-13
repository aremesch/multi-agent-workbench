<script lang="ts">
  import type { PageData } from './$types';
  import { useT } from '$lib/client/i18n.svelte';
  let { data }: { data: PageData } = $props();
  const t = useT();
</script>

<header class="head">
  <h1>{t('roles.title')}</h1>
  <a href="/roles/new" class="btn">{t('roles.newRole')}</a>
</header>

{#if data.roles.length === 0}
  <p class="muted">{t('roles.noRoles')}</p>
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

<p><a href="/" class="muted">{t('roles.backToDashboard')}</a></p>

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
