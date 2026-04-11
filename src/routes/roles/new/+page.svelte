<script lang="ts">
  import type { ActionData, PageData } from './$types';
  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="wrap">
  <h1>New role</h1>
  <form method="post">
    <label>
      <span>Name</span>
      <input name="name" value={form?.name ?? ''} required />
    </label>
    <label>
      <span>CLI kind</span>
      <select name="cli_kind" required>
        {#each data.cliKinds as k (k.kind)}
          <option value={k.kind} selected={form?.cli_kind === k.kind}>{k.displayName} ({k.kind})</option>
        {/each}
      </select>
    </label>
    <label>
      <span>System prompt <span class="muted">(optional)</span></span>
      <textarea name="system_prompt" rows="6">{form?.system_prompt ?? ''}</textarea>
    </label>
    {#if form?.error}
      <p class="err">{form.error}</p>
    {/if}
    <div class="actions">
      <a href="/roles" class="cancel">Cancel</a>
      <button type="submit">Create role</button>
    </div>
  </form>
</div>

<style>
  .wrap {
    max-width: 36rem;
  }
  form {
    display: grid;
    gap: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
  input,
  select,
  textarea {
    padding: 0.5rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #111;
    color: #e5e5e5;
    font-family: inherit;
  }
  textarea {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.85rem;
  }
  .err {
    color: #f87171;
  }
  .muted {
    color: #6b7280;
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
