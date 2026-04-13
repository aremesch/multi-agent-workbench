<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { untrack } from 'svelte';
  import { useT } from '$lib/client/i18n.svelte';

  const t = useT();

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
        const msg = (result.data?.error as string | undefined) ?? t('spawn.error.spawnFailed');
        error = msg;
        return;
      }
      if (result.type === 'error') {
        error = result.error?.message ?? t('spawn.error.spawnFailed');
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
        newRoleError = data.error ?? t('spawn.error.failedCreateRole');
        return;
      }
      const created: SpawnRoleOption = { id: data.id, name: data.name ?? newRoleName, cli_kind: data.cli_kind ?? newRoleCliKind };
      roleOptions = [...roleOptions, created];
      selectedRoleId = created.id;
      showNewRole = false;
      newRoleName = '';
      newRoleCliKind = cliKinds[0]?.kind ?? '';
    } catch {
      newRoleError = t('spawn.error.networkError');
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
        newProjectError = data.error ?? t('spawn.error.failedCreateProject');
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
      newProjectError = t('spawn.error.networkError');
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
        newRepoError = data.error ?? t('spawn.error.failedAddRepo');
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
      newRepoError = t('spawn.error.networkError');
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
          <span>{t('spawn.role')}</span>
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
          title={t('spawn.titleCreateRole')}
        >
          {showNewRole ? t('spawn.collapseRole') : t('spawn.newRole')}
        </button>
      </div>

      {#if showNewRole}
        <div class="inline-form">
          <label>
            <span>{t('spawn.name')}</span>
            <input bind:value={newRoleName} placeholder="e.g. Coder" />
          </label>
          <label>
            <span>{t('spawn.cliKind')}</span>
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
            >{t('spawn.cancel')}</button>
            <button
              type="button"
              onclick={createRole}
              disabled={savingRole || !newRoleName || !newRoleCliKind}
            >{savingRole ? t('spawn.creating') : t('spawn.createRole')}</button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Repo field -->
    <div class="field">
      <div class="field-row">
        <label class="grow">
          <span>{t('spawn.repo')}</span>
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
          title={t('spawn.titleAddRepo')}
        >
          {showNewRepo ? t('spawn.collapseRepo') : t('spawn.newRepo')}
        </button>
      </div>

      {#if showNewRepo}
        <div class="inline-form">
          <!-- Project selector + inline project creation -->
          <div class="field">
            <div class="field-row">
              <label class="grow">
                <span>{t('spawn.project')}</span>
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
                title={t('spawn.titleCreateProject')}
              >
                {showNewProject ? t('spawn.collapseProject') : t('spawn.newProject')}
              </button>
            </div>

            {#if showNewProject}
              <div class="inline-form nested">
                <label>
                  <span>{t('spawn.projectName')}</span>
                  <input bind:value={newProjectName} placeholder="My project" />
                </label>
                <label>
                  <span>{t('spawn.defaultBranch')}</span>
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
                  >{t('spawn.cancel')}</button>
                  <button
                    type="button"
                    onclick={createProject}
                    disabled={savingProject || !newProjectName}
                  >{savingProject ? t('spawn.creating') : t('spawn.createProject')}</button>
                </div>
              </div>
            {/if}
          </div>

          <label>
            <span>Path <span class="muted">({t('spawn.absPath')})</span></span>
            <input bind:value={newRepoPath} placeholder="/home/user/myrepo" />
          </label>
          <label>
            <span>{t('spawn.originUrl')} <span class="muted">({t('spawn.optional')})</span></span>
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
            >{t('spawn.cancel')}</button>
            <button
              type="button"
              onclick={createRepo}
              disabled={savingRepo || showNewProject || !newRepoProjectId || !newRepoPath}
            >{savingRepo ? t('spawn.adding') : t('spawn.addRepo')}</button>
          </div>
        </div>
      {/if}
    </div>

    <label>
      <span>{t('spawn.taskTitle')} <span class="muted">({t('spawn.optional')})</span></span>
      <input name="task_title" />
    </label>
    <label>
      <span>{t('spawn.taskBody')} <span class="muted">({t('spawn.sentAsInitialInput')})</span></span>
      <textarea name="task_body" rows="6"></textarea>
    </label>
    {#if error}
      <p class="err">{error}</p>
    {/if}
    <div class="actions">
      {#if onCancel}
        <button type="button" class="cancel" onclick={onCancel} disabled={submitting}>
          {t('spawn.cancel')}
        </button>
      {:else}
        <a href="/" class="cancel">{t('spawn.cancel')}</a>
      {/if}
      <button type="submit" disabled={submitting || anyInlineOpen || !selectedRoleId || !selectedRepoId}>
        {submitting ? t('spawn.spawning') : t('spawn.spawn')}
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
