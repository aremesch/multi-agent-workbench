# Repository Delete

## Context

The user accidentally added the same repo (`portfolio-import`) twice and has no
way to remove a repository from the UI — the workbench can only add and edit
repos. We need a delete affordance with two safety properties:

1. **Guarded** — a repo may only be deleted when it has **no agents at all**
   (live *or* archived) and **no open queue entries** (open tasks). This is
   both a product requirement ("no open tasks or running agents") and a hard DB
   constraint: `agents.repo_id` and `queue_entries.repo_id` are
   `ON DELETE RESTRICT`, so the row cannot be deleted while either references
   it.
2. **Confirmed** — an explicit "are you sure?" step before anything is removed.

**Critical safety note:** a repo's `path` is the user's *real* git working
tree. Deleting a repo from MAW must only remove the MAW record (and any
MAW-created worktrees under `worktreeRoot`). It must **never** touch the user's
actual repository directory on disk.

Decisions (confirmed with user):
- Delete is blocked unless the repo is fully empty of agents. Archived agents
  must be removed first via the existing Archive page.
- The delete affordance lives inside the existing **Edit Repository** dialog —
  the dialog already shows the repo `path`, which lets the user tell the two
  same-named repos apart before deleting.

## Backend

### Query helpers — `src/lib/server/db/queries.ts`

Add alongside the existing repo helpers (after `updateRepo`, ~line 241):

- `deleteRepo(id, userId): boolean` — `DELETE FROM repos WHERE id = ? AND user_id = ?`; return `res.changes > 0`. Worktree rows cascade automatically.
- `countAgentsForRepo(userId, repoId): number` — `SELECT COUNT(*) AS n FROM agents WHERE user_id = ? AND repo_id = ?` (all statuses — this is the "fully empty" gate).
- `countOpenQueueEntriesForRepo(userId, repoId): number` — mirror of the
  existing `countOpenQueueEntriesByRepo` (~line 1569) but scoped to one repo:
  `... WHERE user_id = ? AND repo_id = ? AND status IN ('pending','blocked','ready','running')`.

Reuse `listWorktreesForRepo(repoId)` (line 265) for on-disk cleanup.

### Endpoint — `src/routes/api/repos/[id]/+server.ts`

Add a `DELETE` handler next to the existing `GET`/`PUT`. Follow the
agent-delete pattern (`src/routes/api/agents/[id]/+server.ts`):

1. `verifyCsrf({ cookies, request })`.
2. Auth + ownership: `getRepo(params.id)`; 401 if no user, 404 if missing or
   `repo.user_id !== locals.user.id` (reuse `common.error.repoNotFound`).
3. **Guard.** If `countAgentsForRepo(...) > 0` or
   `countOpenQueueEntriesForRepo(...) > 0`, return
   `json({ code: 'repo_in_use', agents, openTasks }, { status: 409 })` so the
   UI can explain why.
4. **Worktree disk cleanup.** For each row from `listWorktreesForRepo` whose
   `status !== 'removed'` and whose `path !== repo.path`, best-effort
   `new WorktreeManager(getConfig().worktreeRoot).remove({ repoPath: repo.path, wtPath: worktree.path, force: true })` inside try/catch (log + continue, same as agent-delete). No tmux to kill — the repo has no agents.
5. `deleteRepo(params.id, locals.user.id)` → cascades worktree rows. 404 if it
   returns false.
6. `return new Response(null, { status: 204 })`.

## Frontend

### `src/lib/client/components/RepoEditDialog.svelte`

- Add an optional `onDeleted?: (id: string) => void` prop (sibling of `onSaved`).
- Track `deleting = $state(false)` and `confirmDelete = $state(false)`.
- Add a destructive **Delete repository** button in the `.actions` row (left
  side, separated from Save/Cancel). Clicking it sets `confirmDelete = true`.
- Render `ConfirmDialog` (`tone="destructive"`) with the repo `path` woven into
  the body so the user confirms *which* repo. On confirm, call
  `apiFetch('/api/repos/{id}', { method: 'DELETE' })`:
  - 204 → `onDeleted?.(repoId)`, `onClose()`.
  - 409 `repo_in_use` → set `error` to a message naming the blocking counts
    (e.g. "Can't delete: N agent(s), M open task(s). Remove them first.").
  - other → generic `repoEdit.failedDelete`, reuse `spawn.error.networkError`
    for thrown/network errors.
- Disable Save/Delete while `deleting`.

Reuse the existing `ConfirmDialog.svelte` and `apiFetch` — no new components.

### `src/lib/client/components/RepoTreeSidebar.svelte`

The sidebar owns `RepoEditDialog` (line 255). Pass an `onDeleted` handler that
calls `invalidateAll()` (from `$app/navigation`) and `closeEdit()` so the repo
list refreshes — the `+layout.server.ts` load rebuilds `activeRepos`.

### i18n — `src/lib/i18n/en.ts`

Add to the `repoEdit.*` block (~line 37):
- `repoEdit.delete`: "Delete repository"
- `repoEdit.deleting`: "Deleting…"
- `repoEdit.confirmDeleteTitle`: "Delete repository?"
- `repoEdit.confirmDeleteBody`: "Permanently remove \"{path}\" from the workbench? This only removes it from MAW — your files on disk are untouched. This cannot be undone."
- `repoEdit.failedDelete`: "Failed to delete repository"
- `repoEdit.inUse`: "Can't delete: this repository still has {agents} agent(s) and {tasks} open task(s). Remove them first."

(Confirm the `t()` helper's interpolation syntax against an existing
parameterized key such as `sidebar.queueBadge` / `roles.error.inUse` and match
it.)

## Tests

Follow existing endpoint test conventions (check for sibling `*.test.ts` under
`src/routes/api/` or `src/lib/server/db/`). Cover:
- DELETE removes a fully-empty repo → 204, row gone, worktree rows gone.
- DELETE on a repo with a live agent → 409 `repo_in_use`, row preserved.
- DELETE on a repo with an archived agent → 409 (fully-empty gate), row preserved.
- DELETE on a repo with an open queue entry → 409, row preserved.
- DELETE on another user's repo → 404, row preserved.
- Missing CSRF token → rejected.

If no API-route test harness exists, add unit tests for the new query helpers
(`deleteRepo`, `countAgentsForRepo`, `countOpenQueueEntriesForRepo`) against an
in-memory DB, matching the existing `queries` test style.

## Verification

1. `pnpm dev`, log in.
2. Create two repos pointing at the same path (reproduce the duplicate).
3. Open the edit dialog on one → **Delete repository** → confirm. It
   disappears from the sidebar; the other remains. Verify the on-disk repo
   directory is untouched.
4. Spawn an agent in a repo, then try to delete that repo → blocked with the
   "agents / open tasks" message. Exit + delete the agent via Archive, leave
   it fully empty, then delete succeeds.
5. Run the test suite (`pnpm test` or project equivalent) and the linter.
