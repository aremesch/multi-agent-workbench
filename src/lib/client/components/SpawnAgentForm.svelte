<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { untrack } from 'svelte';

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
  export interface SpawnProjectOption {
    id: string;
    name: string;
    default_branch: string;
  }
  export interface CliKindOption {
    kind: string;
    displayName: string;
  }

  let {
    roles,
    repos,
    projects,
    cliKinds,
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
    projects: SpawnProjectOption[];
    cliKinds: CliKindOption[];
    onSuccess?: (agentId: string) => void;
    onCancel?: () => void;
  } = $props();

  // Mutable copies that grow as the user creates new items inline.
  // untrack() intentionally captures the initial prop values — we don't want
  // these to re-derive when props change; mutations come from inline creation.
  let roleOptions = $state<SpawnRoleOption[]>(untrack(() => [...roles]));
  let repoOptions = $state<SpawnRepoOption[]>(untrack(() => [...repos]));
  let projectOptions = $state<SpawnProjectOption[]>(untrack(() => [...projects]));

  let selectedRoleId = $state(untrack(() => roles[0]?.id ?? ''));
  let selectedRepoId = $state(untrack(() => repos[0]?.id ?? ''));

  // ── Inline role creation ────────────────────────────────────────────────
  let showNewRole = $state(false);
  let newRoleName = $state('');
  let newRoleCliKind = $state(untrack(() => cliKinds[0]?.kind ?? ''));
  let newRoleError = $state<string | null>(null);
  let savingRole = $state(false);

  // ── Inline repo creation ────────────────────────────────────────────────
  let showNewRepo = $state(false);
  let newRepoProjectId = $state(untrack(() => projects[0]?.id ?? ''));
  let newRepoPath = $state('');
  let newRepoOriginUrl = $state('');
  let newRepoError = $state<string | null>(null);
  let savingRepo = $state(false);

  // ── Nested inline project creation (inside repo form) ───────────────────
  let showNewProject = $state(false);
  let newProjectName = $state('');
  let newProjectBranch = $state('main');
  let newProjectError = $state<string | null>(null);
  let savingProject = $state(false);

  // ── Spawn form ──────────────────────────────────────────────────────────
  let error = $state<string | null>(null);
  let submitting = $state(false);

  const anyInlineOpen = $derived(showNewRole || showNewRepo);

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

  // ── Inline creation handlers ────────────────────────────────────────────

  async function createRole(): Promise<void> {
    newRoleError = null;
    savingRole = true;
    try {
      const res = await fetch('/api/roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newRoleName, cli_kind: newRoleCliKind })
      });
      const data = (await res.json()) as { id?: string; name?: string; cli_kind?: string; error?: string };
      if (!res.ok || !data.id) {
        newRoleError = data.error ?? 'Failed to create role';
        return;
      }
      const created: SpawnRoleOption = { id: data.id, name: data.name ?? newRoleName, cli_kind: data.cli_kind ?? newRoleCliKind };
      roleOptions = [...roleOptions, created];
      selectedRoleId = created.id;
      showNewRole = false;
      newRoleName = '';
      newRoleCliKind = cliKinds[0]?.kind ?? '';
    } catch {
      newRoleError = 'Network error';
    } finally {
      savingRole = false;
    }
  }

  async function createProject(): Promise<void> {
    newProjectError = null;
    savingProject = true;
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newProjectName, default_branch: newProjectBranch })
      });
      const data = (await res.json()) as { id?: string; name?: string; default_branch?: string; error?: string };
      if (!res.ok || !data.id) {
        newProjectError = data.error ?? 'Failed to create project';
        return;
      }
      const created: SpawnProjectOption = {
        id: data.id,
        name: data.name ?? newProjectName,
        default_branch: data.default_branch ?? newProjectBranch
      };
      projectOptions = [...projectOptions, created];
      newRepoProjectId = created.id;
      showNewProject = false;
      newProjectName = '';
      newProjectBranch = 'main';
    } catch {
      newProjectError = 'Network error';
    } finally {
      savingProject = false;
    }
  }

  async function createRepo(): Promise<void> {
    newRepoError = null;
    savingRepo = true;
    try {
      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: newRepoProjectId,
          path: newRepoPath,
          origin_url: newRepoOriginUrl || undefined
        })
      });
      const data = (await res.json()) as { id?: string; path?: string; projectName?: string; error?: string };
      if (!res.ok || !data.id) {
        newRepoError = data.error ?? 'Failed to add repo';
        return;
      }
      const created: SpawnRepoOption = {
        id: data.id,
        path: data.path ?? newRepoPath,
        projectName: data.projectName ?? ''
      };
      repoOptions = [...repoOptions, created];
      selectedRepoId = created.id;
      showNewRepo = false;
      showNewProject = false;
      newRepoPath = '';
      newRepoOriginUrl = '';
      newRepoProjectId = projectOptions[0]?.id ?? '';
    } catch {
      newRepoError = 'Network error';
    } finally {
      savingRepo = false;
    }
  }
</script>

<div class="wrap">
  <form
    method="post"
    action="/agents/new"
    use:enhance={() => {
      onSubmitStart();
      return submit();
    }}
  >
    <!-- Role field -->
    <div class="field">
      <div class="field-row">
        <label class="grow">
          <span>Role</span>
          <select name="role_id" bind:value={selectedRoleId} required>
            {#each roleOptions as r (r.id)}
              <option value={r.id}>{r.name} ({r.cli_kind})</option>
            {/each}
          </select>
        </label>
        <button
          type="button"
          class="inline-add"
          onclick={() => { showNewRole = !showNewRole; newRoleError = null; }}
          title="Create new role"
        >
          {showNewRole ? '−' : '+ Role'}
        </button>
      </div>

      {#if showNewRole}
        <div class="inline-form">
          <label>
            <span>Name</span>
            <input bind:value={newRoleName} placeholder="e.g. Coder" />
          </label>
          <label>
            <span>CLI kind</span>
            <select bind:value={newRoleCliKind}>
              {#each cliKinds as k (k.kind)}
                <option value={k.kind}>{k.displayName} ({k.kind})</option>
              {/each}
            </select>
          </label>
          {#if newRoleError}
            <p class="err">{newRoleError}</p>
          {/if}
          <div class="inline-actions">
            <button
              type="button"
              class="cancel"
              onclick={() => { showNewRole = false; newRoleError = null; newRoleName = ''; }}
              disabled={savingRole}
            >Cancel</button>
            <button
              type="button"
              onclick={createRole}
              disabled={savingRole || !newRoleName || !newRoleCliKind}
            >{savingRole ? 'Creating…' : 'Create role'}</button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Repo field -->
    <div class="field">
      <div class="field-row">
        <label class="grow">
          <span>Repo</span>
          <select name="repo_id" bind:value={selectedRepoId} required>
            {#each repoOptions as r (r.id)}
              <option value={r.id}>{r.projectName} — {r.path}</option>
            {/each}
          </select>
        </label>
        <button
          type="button"
          class="inline-add"
          onclick={() => { showNewRepo = !showNewRepo; newRepoError = null; }}
          title="Add new repo"
        >
          {showNewRepo ? '−' : '+ Repo'}
        </button>
      </div>

      {#if showNewRepo}
        <div class="inline-form">
          <!-- Project selector + inline project creation -->
          <div class="field">
            <div class="field-row">
              <label class="grow">
                <span>Project</span>
                <select bind:value={newRepoProjectId}>
                  {#each projectOptions as p (p.id)}
                    <option value={p.id}>{p.name}</option>
                  {/each}
                </select>
              </label>
              <button
                type="button"
                class="inline-add"
                onclick={() => { showNewProject = !showNewProject; newProjectError = null; }}
                title="Create new project"
              >
                {showNewProject ? '−' : '+ Project'}
              </button>
            </div>

            {#if showNewProject}
              <div class="inline-form nested">
                <label>
                  <span>Project name</span>
                  <input bind:value={newProjectName} placeholder="My project" />
                </label>
                <label>
                  <span>Default branch</span>
                  <input bind:value={newProjectBranch} placeholder="main" />
                </label>
                {#if newProjectError}
                  <p class="err">{newProjectError}</p>
                {/if}
                <div class="inline-actions">
                  <button
                    type="button"
                    class="cancel"
                    onclick={() => { showNewProject = false; newProjectError = null; newProjectName = ''; newProjectBranch = 'main'; }}
                    disabled={savingProject}
                  >Cancel</button>
                  <button
                    type="button"
                    onclick={createProject}
                    disabled={savingProject || !newProjectName}
                  >{savingProject ? 'Creating…' : 'Create project'}</button>
                </div>
              </div>
            {/if}
          </div>

          <label>
            <span>Path <span class="muted">(absolute filesystem path)</span></span>
            <input bind:value={newRepoPath} placeholder="/home/user/myrepo" />
          </label>
          <label>
            <span>Origin URL <span class="muted">(optional)</span></span>
            <input bind:value={newRepoOriginUrl} placeholder="https://github.com/…" />
          </label>
          {#if newRepoError}
            <p class="err">{newRepoError}</p>
          {/if}
          <div class="inline-actions">
            <button
              type="button"
              class="cancel"
              onclick={() => { showNewRepo = false; showNewProject = false; newRepoError = null; newRepoPath = ''; newRepoOriginUrl = ''; }}
              disabled={savingRepo}
            >Cancel</button>
            <button
              type="button"
              onclick={createRepo}
              disabled={savingRepo || showNewProject || !newRepoProjectId || !newRepoPath}
            >{savingRepo ? 'Adding…' : 'Add repo'}</button>
          </div>
        </div>
      {/if}
    </div>

    <label>
      <span>Agent name <span class="muted">(optional)</span></span>
      <input name="agent_name" placeholder="e.g. auth-refactor" />
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
      <button type="submit" disabled={submitting || anyInlineOpen || !selectedRoleId || !selectedRepoId}>
        {submitting ? 'Spawning…' : 'Spawn'}
      </button>
    </div>
  </form>
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
  .field {
    display: grid;
    gap: 0.4rem;
  }
  .field-row {
    display: flex;
    gap: 0.4rem;
    align-items: flex-end;
  }
  .field-row .grow {
    flex: 1;
    min-width: 0;
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
  .inline-add {
    padding: 0.45rem 0.6rem;
    border-radius: 0.375rem;
    border: 1px solid #374151;
    background: #1a1a1a;
    color: #93c5fd;
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
    white-space: nowrap;
    flex-shrink: 0;
    align-self: flex-end;
  }
  .inline-add:hover {
    background: #1e293b;
  }
  .inline-form {
    border-left: 2px solid #2563eb;
    padding-left: 0.75rem;
    display: grid;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .inline-form label {
    font-size: 0.85rem;
  }
  .inline-form input,
  .inline-form select {
    padding: 0.4rem 0.5rem;
    font-size: 0.85rem;
  }
  .inline-form.nested {
    border-left-color: #6b7280;
    margin-left: 0.5rem;
  }
  .inline-actions {
    display: flex;
    gap: 0.4rem;
    justify-content: flex-end;
  }
  .inline-actions button:not(.cancel) {
    padding: 0.4rem 0.75rem;
    border-radius: 0.375rem;
    background: #2563eb;
    border: none;
    color: #fff;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
  }
  .inline-actions button:not(.cancel):disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .err {
    color: #f87171;
    margin: 0;
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
