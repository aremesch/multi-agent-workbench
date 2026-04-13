<script lang="ts">
  import type { ActionData, PageData } from './$types';
  import { useT } from '$lib/client/i18n.svelte';
  let { form, data }: { form: ActionData; data: PageData } = $props();
  const t = useT();
</script>

<div class="wrap">
  <h1>{t('account.title')}</h1>
  <p class="meta">{t('account.signedInAs', { username: data.username })}</p>

  <h2>{t('account.changePassword')}</h2>
  <form method="post" action="?/changePassword">
    <label>
      <span>{t('account.currentPw')}</span>
      <input name="current" type="password" autocomplete="current-password" required />
    </label>
    <label>
      <span>{t('account.newPw')}</span>
      <input name="next" type="password" autocomplete="new-password" minlength="8" required />
    </label>
    <label>
      <span>{t('account.confirmPw')}</span>
      <input name="confirm" type="password" autocomplete="new-password" minlength="8" required />
    </label>
    {#if form?.error}
      <p class="err">{form.error}</p>
    {/if}
    {#if form?.success}
      <p class="ok">{t('account.pwUpdated')}</p>
    {/if}
    <button type="submit">{t('account.updatePw')}</button>
  </form>
</div>

<style>
  .wrap {
    max-width: 28rem;
    margin: 3rem auto;
  }
  h2 {
    margin-top: 2rem;
    font-size: 1.1rem;
  }
  .meta {
    color: #9ca3af;
    font-size: 0.9rem;
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
  .ok {
    color: #4ade80;
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
