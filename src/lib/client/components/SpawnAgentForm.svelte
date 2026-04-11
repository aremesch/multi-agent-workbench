<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';

  export interface SpawnRoleOption {
    id: string;
    name: string;
    cli_kind: string;
  }
  export interface SpawnRepoOption {
    id: string;
    path: string;
    projectName: string;
  }

  let {
    roles,
    repos,
    /**
     * Called with the new agent id after a successful spawn. The dashboard
     * uses this to close the modal + navigate to the agent detail page.
     * If omitted, the component falls back to a plain navigation.
     */
    onSuccess,
    onCancel
  }: {
    roles: SpawnRoleOption[];
    repos: SpawnRepoOption[];
    onSuccess?: (agentId: string) => void;
    onCancel?: () => void;
  } = $props();

  let error = $state<string | null>(null);
  let submitting = $state(false);

  /**
   * We POST to `/agents/new` (its action handler owns the whole spawn
   * pipeline — worktree create, row insert, supervisor.spawn, …) from
   * wherever this form lives. `use:enhance` lets us intercept the result
   * so the dashboard-hosted modal can close itself and navigate instead
   * of doing a full page transition.
   */
  function submit() {
    return async ({
      result,
      update
    }: {
      result: {
        type: 'success' | 'failure' | 'redirect' | 'error';
        status?: number;
        location?: string;
        data?: Record<string, unknown>;
        error?: Error;
      };
      update: (opts?: { reset?: boolean }) => Promise<void>;
    }): Promise<void> => {
      submitting = false;
      if (result.type === 'redirect' && result.location) {
        // The action redirects to /agents/:id on success.
        const match = /\/agents\/([^/?#]+)/.exec(result.location);
        const agentId = match?.[1];
        if (agentId && onSuccess) {
          onSuccess(agentId);
          return;
        }
        await goto(result.location);
        return;
      }
      if (result.type === 'failure') {
        const msg = (result.data?.error as string | undefined) ?? 'Spawn failed';
        error = msg;
        return;
      }
      if (result.type === 'error') {
        error = result.error?.message ?? 'Spawn failed';
        return;
      }
      await update();
    };
  }

  function onSubmitStart(): void {
    error = null;
    submitting = true;
  }
</script>

<div class="wrap">
  {#if roles.length === 0 || repos.length === 0}
    <p class="warn">
      You need at least one {roles.length === 0 ? 'role' : ''}{#if roles.length === 0 && repos.length === 0} and one {/if}{repos.length === 0 ? 'repo' : ''} before you can spawn an agent.
    </p>
    <ul class="muted">
      {#if roles.length === 0}
        <li><a href="/roles/new">Create a role</a></li>
      {/if}
      {#if repos.length === 0}
        <li><a href="/projects/new">Create a project and attach a repo</a></li>
      {/if}
    </ul>
  {:else}
    <form
      method="post"
      action="/agents/new"
      use:enhance={() => {
        onSubmitStart();
        return submit();
      }}
    >
      <label>
        <span>Role</span>
        <select name="role_id" required>
          {#each roles as r (r.id)}
            <option value={r.id}>{r.name} ({r.cli_kind})</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Repo</span>
        <select name="repo_id" required>
          {#each repos as r (r.id)}
            <option value={r.id}>{r.projectName} — {r.path}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Task title <span class="muted">(optional)</span></span>
        <input name="task_title" />
      </label>
      <label>
        <span>Task body <span class="muted">(optional, sent as initial input)</span></span>
        <textarea name="task_body" rows="6"></textarea>
      </label>
      {#if error}
        <p class="err">{error}</p>
      {/if}
      <div class="actions">
        {#if onCancel}
          <button type="button" class="cancel" onclick={onCancel} disabled={submitting}>
            Cancel
          </button>
        {:else}
          <a href="/" class="cancel">Cancel</a>
        {/if}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Spawning…' : 'Spawn'}
        </button>
      </div>
    </form>
  {/if}
</div>

<style>
  .wrap {
    /* A comfortable intrinsic width so inputs and the Project — Path
       repo option line have room to breathe, while still shrinking on
       narrow viewports (the Modal's `size="fit"` only clamps at 95vw). */
    width: 28rem;
    max-width: 100%;
  }
  form {
    display: grid;
    gap: 0.75rem;
  }
  input,
  select,
  textarea {
    width: 100%;
    box-sizing: border-box;
  }
  label {
    display: grid;
    gap: 0.25rem;
    color: #e5e7eb;
    font-size: 0.9rem;
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
    margin: 0;
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
    background: transparent;
    border: none;
    cursor: pointer;
    font: inherit;
  }
  .cancel:hover:not(:disabled) {
    color: #e5e7eb;
  }
  button[type='submit'] {
    padding: 0.55rem 1rem;
    border-radius: 0.375rem;
    background: #2563eb;
    border: none;
    color: #fff;
    cursor: pointer;
  }
  button[type='submit']:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  a {
    color: #93c5fd;
  }
</style>
