<script lang="ts">
  import type { ActionData } from './$types';
  import { useT } from '$lib/client/i18n.svelte';
  let { form }: { form: ActionData } = $props();
  const t = useT();
</script>

<div class="wrap">
  <h1>{t('login.title')}</h1>
  <form method="post" action="?/login">
    <label>
      <span>{t('login.username')}</span>
      <input name="username" autocomplete="username" value={form?.username ?? ''} required />
    </label>
    <label>
      <span>{t('login.password')}</span>
      <input name="password" type="password" autocomplete="current-password" required />
    </label>
    {#if form?.error}
      <p class="err">{form.error}</p>
    {/if}
    <button type="submit">{t('login.submit')}</button>
  </form>
</div>

<style>
  .wrap {
    max-width: 28rem;
    margin: 3rem auto;
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
  button {
    padding: 0.55rem 1rem;
    border-radius: 0.375rem;
    background: #2563eb;
    border: none;
    color: #fff;
    cursor: pointer;
  }
</style>
