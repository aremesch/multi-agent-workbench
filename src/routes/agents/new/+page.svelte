<script lang="ts">
  import type { ActionData, PageData } from './$types';
  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="wrap">
  <h1>Spawn agent</h1>

  {#if data.roles.length === 0 || data.repos.length === 0}
    <p class="warn">
      You need at least one {data.roles.length === 0 ? 'role' : ''}{#if data.roles.length === 0 && data.repos.length === 0} and one {/if}{data.repos.length === 0 ? 'repo' : ''} before you can spawn an agent.
    </p>
    <ul class="muted">
      {#if data.roles.length === 0}
        <li><a href="/roles/new">Create a role</a></li>
      {/if}
      {#if data.repos.length === 0}
        <li><a href="/projects/new">Create a project and attach a repo</a></li>
      {/if}
    </ul>
  {:else}
    <form method="post">
      <label>
        <span>Role</span>
        <select name="role_id" required>
          {#each data.roles as r (r.id)}
            <option value={r.id} selected={form?.role_id === r.id}>
              {r.name} ({r.cli_kind})
            </option>
          {/each}
        </select>
      </label>
      <label>
        <span>Repo</span>
        <select name="repo_id" required>
          {#each data.repos as r (r.id)}
            <option value={r.id} selected={form?.repo_id === r.id}>
              {r.projectName} — {r.path}
            </option>
          {/each}
        </select>
      </label>
      <label>
        <span>Task title <span class="muted">(optional)</span></span>
        <input name="task_title" value={form?.task_title ?? ''} />
      </label>
      <label>
        <span>Task body <span class="muted">(optional, sent as initial input)</span></span>
        <textarea name="task_body" rows="6">{form?.task_body ?? ''}</textarea>
      </label>
      {#if form?.error}
        <p class="err">{form.error}</p>
      {/if}
      <div class="actions">
        <a href="/" class="cancel">Cancel</a>
        <button type="submit">Spawn</button>
      </div>
    </form>
  {/if}
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
  .warn {
    color: #fbbf24;
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
  a {
    color: #93c5fd;
  }
</style>
