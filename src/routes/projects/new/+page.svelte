<script lang="ts">
  import type { ActionData } from './$types';
  import { useT } from '$lib/client/i18n.svelte';
  let { form }: { form: ActionData } = $props();
  const t = useT();
</script>

<div class="wrap">
  <h1>{t('newProject.title')}</h1>
  <form method="post">
    <label>
      <span>{t('spawn.name')}</span>
      <input name="name" value={form?.name ?? ''} required />
    </label>
    <label>
      <span>{t('spawn.defaultBranch')}</span>
      <input name="default_branch" value={form?.default_branch ?? 'main'} required />
    </label>
    {#if form?.error}
      <p class="err">{form.error}</p>
    {/if}
    <div class="actions">
      <a href="/" class="cancel">{t('spawn.cancel')}</a>
      <button type="submit">{t('spawn.createProject')}</button>
    </div>
  </form>
</div>

<style>
  .wrap {
    max-width: 28rem;
  }
  form {
    display: grid;
    gap: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
  input {
    padding: 0.5rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #111;
    color: #e5e5e5;
  }
  .err {
    color: #f87171;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    align-items: center;
  }
  .cancel {
    color: #9ca3af;
    text-decoration: none;
    padding: 0.55rem 0.75rem;
  }
  button {
    padding: 0.55rem 1rem;
    border-radius: 0.375rem;
    background: #2563eb;
    border: none;
    color: #fff;
    cursor: pointer;
  }
</style>
