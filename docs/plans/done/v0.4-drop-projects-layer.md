# Remove the Projects / polyrepo-workspace layer

> **First execution steps (per global CLAUDE.md, can't be done in plan mode):**
> 1. `git mv docs/plans/recently-polyrepo-support-was-swift-toast.md docs/plans/v0.4-drop-projects-layer.md`
> 2. Rename branch: `git branch -m refactor/v0.4-drop-projects-layer`
> 3. `git pull` into the worktree before starting.

## Context

`v0.4-polyrepo-workspace.md` recently added a **Projects** layer: a `projects` table, a
`projects.workspace_root` column, a `/projects` API + UI, and a batch-import flow that adds
several sibling git repos from a parent folder. None of it is linked from the app nav — the
pages are only reachable by typing `/projects/...` URLs by hand.

We evaluated whether the concept earns its keep. It does **not**:

- Every agent spawns into an isolated git worktree of **exactly one repo**
  (`spawnFromInputs.ts` → `WorktreeManager.create()` → `AgentSupervisor.spawn()`). There is no
  shared worktree, no cross-repo visibility, and no combined prompt.
- `projects.workspace_root` is **written once** at import and **never read** by any runtime
  code path — purely a cosmetic label.
- At spawn time a project is consulted for **one** thing: a `default_branch` fallback, which
  the per-repo `repos.default_branch` already covers.
- `CLAUDE.md` already declares cross-repo visibility / shared worktrees out of scope.

So grouping repos under a "workspace" buys nothing over adding the repos individually and
referencing sibling paths in the agent prompt when needed (the task body is passed to the CLI
unrestricted — this already works today).

**Decision (user):** remove the entire Projects layer, leanest path. Do **not** add a
batch-add / polyrepo-detection feature. Repos continue to be added one at a time via the
existing "New repo" sub-form in the spawn dialog (which already creates repos with
`project_id = null`).

This is a purely **subtractive** refactor. Outcome: `repos` becomes the only top-level entity;
~30 files shed their dead `project_name` / `project_id` threading; one DB migration drops the
`projects` table and the `repos.project_id` column.

## Scope at a glance

- **Delete** the `/projects` API + UI tree and the `/api/projects` endpoint (+ their tests).
- **Migrate** the DB: rebuild `repos` without `project_id` (keep `default_branch`), drop the
  `projects` table.
- **Strip** all `project_id` / `project_name` / `projectName` reads from the data layer,
  server endpoints, loaders, and client components.
- **Prune** orphaned i18n keys.
- **Keep** the generic `DirectoryPickerDialog` and all `picker.*` i18n keys — single-repo add
  still uses them.

## Step 1 — Delete files/routes

Whole `src/routes/projects/` tree + the projects API (verified nothing else lives under them):

- `src/routes/api/projects/+server.ts`, `src/routes/api/projects/server.test.ts`
- `src/routes/projects/new/{+page.server.ts,+page.svelte}`
- `src/routes/projects/[id]/{+page.server.ts,+page.svelte}`
- `src/routes/projects/[id]/repos/new/{+page.server.ts,+page.svelte}`
- `src/routes/projects/[id]/repos/import/{+page.server.ts,+page.svelte,server.test.ts}`

(No nav links point at `/projects`, so no nav cleanup is needed.)

## Step 2 — DB migration `migrations/014_drop_projects.sql`

Follows the migration-004 rebuild pattern. The runner wraps each file in a transaction and
toggles `foreign_keys=OFF` around it; inside the tx we use `defer_foreign_keys=ON` so the
`worktrees`/`agents` rows that reference `repos(id)` still resolve after the rename (IDs are
preserved). `COALESCE` preserves the effective branch for any repo that was inheriting it from
its project via a NULL `repos.default_branch`.

```sql
-- Remove the Projects feature: rebuild repos without project_id, then drop projects.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE repos_new (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  origin_url     TEXT,
  default_branch TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

INSERT INTO repos_new (id, user_id, path, origin_url, default_branch, created_at, updated_at)
SELECT r.id, r.user_id, r.path, r.origin_url,
       COALESCE(r.default_branch, p.default_branch),
       r.created_at, r.updated_at
  FROM repos r
  LEFT JOIN projects p ON p.id = r.project_id;

DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;

CREATE INDEX idx_repos_user ON repos(user_id);
-- idx_repos_project intentionally not recreated (column removed).

DROP INDEX IF EXISTS idx_projects_user;
DROP TABLE projects;
```

## Step 3 — Data layer

**`src/lib/server/db/types.ts`**
- Delete `ProjectRow` (lines ~61–71).
- Remove `project_id` from `RepoRow` (line ~76).

**`src/lib/server/db/queries.ts`**
- Remove the imports/functions: `listProjects`, `getProject`, `insertProject`,
  `setProjectWorkspaceRoot`, `listReposForProject`, and the `ProjectRow` import.
- `listReposWithProjectForUser` (~243–251): drop the `LEFT JOIN projects` and `project_name`.
  Rename to `listRepoOptionsForUser` + `RepoOptionRow` (`{ id, path }`) so the name stops
  lying (single call site: dashboard loader).
- `insertRepo` (~263–284): drop the `project_id` param + column from the INSERT.
- **Agent-card queries** — remove `LEFT JOIN projects p` + `p.name AS project_name` from all
  four, and `project_name` from the `AgentCardRow` interface (line ~542):
  `listAgentCardsForUser` (~546), `listAgentCardsForRepo` (~570), `getAgentCard` (~601),
  `listAgentCardsByIds` (~623).

**`src/lib/shared/types.ts`**
- Remove `project_name` from `AgentCardRow` and `projectName` from `SidebarRepoNode`.

## Step 4 — Server reads (4 files)

- **`src/routes/api/repos/+server.ts`** — drop `getProject` import + the whole `project_id`
  block (lines ~26–44) and the `project_id` field in `insertRepo` (~133). Keep
  `effectiveDefaultBranch = default_branch_in || 'main'` and
  `storedDefaultBranch = default_branch_in || null`. Response stays `projectName: basename(path)`.
- **`src/routes/api/repos/[id]/+server.ts`** (~5,14) — drop `getProject`; set
  `projectName = basename(repo.path)`.
- **`src/lib/server/agents/spawnFromInputs.ts`** (~26,225) — drop the `getProject` import;
  branch fallback becomes `raw.branch || repo.default_branch || 'main'`.
- **`src/lib/server/git/commitSnapshot.ts`** (~20,84) — drop `getProject`; default branch
  becomes `repo.default_branch ?? 'main'`.

## Step 5 — Loaders (drop `project_name` / `projectName` mapping)

`src/routes/+page.server.ts` (uses renamed `listRepoOptionsForUser`; `DashboardRepoOption`
drops `projectName`), `src/routes/+layout.server.ts` (stops populating `SidebarRepoNode.projectName`),
`src/routes/repos/[id]/+page.server.ts`, `src/routes/queue/+page.server.ts`,
`src/routes/settings/+page.server.ts`, `src/routes/agents/new/+page.server.ts`,
`src/routes/archive/+page.server.ts`, `src/routes/agents/[id]/+page.server.ts`.

## Step 6 — Client components

- **`SpawnAgentForm.svelte`** — `SpawnRepoOption` drops `projectName` (~26); repo `<option>`
  label becomes just `{r.path}` (~832); `createRepo()` stops reading `data.projectName` (~756).
- **`RepoTreeSidebar.svelte`** — title tooltips use `repo.repoPath` only (~124,171,241).
- **`AgentCard.svelte`** (~201), **`AgentWindowModal.svelte`** (~34,135),
  **`src/routes/+page.svelte`** (~94) — rebuild the card/window title without `project_name`
  (fall back to `task_title` / repo path).
- **`src/routes/queue/+page.svelte`** (~106) and **`src/routes/archive/+page.svelte`**
  (~27 column header, ~44 cell) — show `path` / `repoPath` instead of project.

## Step 7 — i18n (`en.ts`, then mirror in `de.ts`/`fr.ts`/`es.ts`)

Locales spread over `en`, and `TranslationKey` derives from `en`, so removing a key from
`en.ts` makes `pnpm check` flag any remaining usage. Remove the now-orphaned keys (grep each
to confirm zero usage first): `spawn.projectName`, `spawn.createProject`, `spawn.newProject`,
`spawn.collapseProject`, `spawn.titleCreateProject`, `spawn.error.orphanedRepo`,
`spawn.error.failedCreateProject`, `projects.*`, `newProject.*`, `newRepo.attachDesc`,
`import.*`, `common.error.projectNotFound`. **Keep** all `picker.*` keys (picker stays).

## Step 8 — Tests

Update (don't blanket-delete) the suites that seed/mocked projects so they reflect the new
schema; delete only the tests for deleted routes:

- **Delete:** `src/routes/api/projects/server.test.ts`,
  `src/routes/projects/[id]/repos/import/server.test.ts` (gone with their routes).
- **Update:** `src/lib/server/db/queries.test.ts` (drop project seeders + project test cases,
  remove `project_id` from repo seeders); `src/lib/server/db/migrate.test.ts` (keep the 004
  assertion, add a 014 assertion: `projects` gone, `repos.project_id` gone);
  `src/lib/server/git/commitSnapshot.test.ts`, `src/lib/server/queue/Scheduler.test.ts`,
  `src/lib/server/agents/alertContent.test.ts` (drop `insertProject` + `project_id`);
  `src/routes/api/repos/server.test.ts`, `src/routes/api/repos/[id]/server.test.ts` (drop the
  `getProjectMock` / project-name cases; keep the `basename(path)` behavior);
  `src/lib/client/components/SpawnAgentForm.svelte.test.ts`,
  `src/routes/queue/page.svelte.test.ts` (drop `projectName`).

## Critical files

- `migrations/014_drop_projects.sql` (new) — modeled on `migrations/004_repo_project_optional.sql`
- `src/lib/server/db/queries.ts`, `src/lib/server/db/types.ts`, `src/lib/shared/types.ts`
- `src/routes/api/repos/+server.ts`, `src/routes/api/repos/[id]/+server.ts`
- `src/lib/server/agents/spawnFromInputs.ts`, `src/lib/server/git/commitSnapshot.ts`
- `src/lib/client/components/SpawnAgentForm.svelte`, `RepoTreeSidebar.svelte`, `AgentCard.svelte`

## Verification

1. **Type + lint:** `pnpm check` (catches every dangling `project_name`/`projectName`/removed
   i18n key) and `pnpm lint`.
2. **Migration:** apply against a copy of the dev DB and confirm `projects` is gone,
   `repos.project_id` is gone, repo rows + their `default_branch` survived, and existing
   agents/worktrees still resolve. `pnpm test` runs `migrate.test.ts`.
3. **Unit/component:** `pnpm test` (server + client) green.
4. **Manual smoke (dev server in browser):**
   - Add a repo via the spawn dialog's "New repo" → Browse → confirm it still creates the repo
     (`project_id` now absent) and the dropdown shows the bare path.
   - Spawn an agent → it runs in its worktree as before (branch resolves to repo default / `main`).
   - Sidebar repo tree, agent cards, queue list, and archive view all render with no
     project label and no console errors.
   - `GET /projects` and `GET /projects/<anything>` now 404.
