<script lang="ts">
  import type { ActionData, PageData } from './$types';
  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="wrap">
  <h1>New repo</h1>
  <p class="muted">Attach an existing git working tree to <strong>{data.project.name}</strong>.</p>
  <form method="post">
    <label>
      <span>Absolute path</span>
      <input name="path" value={form?.path ?? ''} placeholder="/home/you/code/my-repo" required />
    </label>
    <label>
      <span>Origin URL <span class="muted">(optional)</span></span>
      <input name="origin_url" value={form?.origin_url ?? ''} placeholder="git@github.com:org/repo.git" />
    </label>
    {#if form?.error}
      <p class="err">{form.error}</p>
    {/if}
    <div class="actions">
      <a href={`/projects/${data.project.id}`} class="cancel">Cancel</a>
      <button type="submit">Attach repo</button>
    </div>
  </form>
</div>

<style>
  .wrap {
    max-width: 32rem;
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
