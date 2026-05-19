# Add an Edit button to each task

## Context

Tasks are created via the FAB → `SpawnAgentForm` (mode `queue`) on the Tasks
page (`/queue`). Once created, a task sits in the list (backlog / ready /
blocked) until the scheduler runs it. Today there is **no way to change a
task after creating it** — the only per-task actions are Run now / Queue /
Send to backlog / Cancel. The user wants to fix a typo, tweak the prompt,
change the model/role, adjust priority/schedule/deps, etc. *before* the task
runs.

The backend already supports this: **`PUT /api/queue/:id`** is fully
implemented (`src/routes/api/queue/[id]/+server.ts`). It re-runs the spawn
validator, refuses entries that are `running` / `done` / `failed` /
`cancelled` (409 `queue.error.notEditable`), resets `status → pending` so the
scheduler re-evaluates, clears `last_error`, and intentionally leaves the
`queued` bit untouched (admission stays controlled by the
`/queue` & `/backlog` endpoints). The i18n key `queue.action.edit` (`"Edit"`)
already exists. So this is almost entirely a **frontend** change:
parameterize the existing form for editing and wire an Edit button.

## Scope of editable tasks

Edit is offered for non-running, non-terminal tasks only — i.e. the
**backlog**, **ready**, and **blocked** buckets. Not **running** (agent is
live) and not **completed** (done/failed/cancelled). This matches both the
user's intent ("before running it") and the backend's 409 rule, so the UI
never surfaces an action the API will reject.

## Approach

Reuse `SpawnAgentForm` (per project UI/DRY conventions — no one-off duplicate
form). Pre-fill it from the `QueueEntryRow` already in memory on the page
(`+page.server.ts` loads full rows — **no extra GET fetch needed**), and send
the edits to `PUT /api/queue/:id` with the same snake_case body shape the
create flow POSTs (both go through `coerceQueueInput`).

### 1. `src/lib/client/components/SpawnAgentForm.svelte` — parameterize for edit

Add two optional props (keep `mode: 'spawn' | 'queue'` unchanged so the
existing `{#if mode === 'queue'}` field blocks render as-is for edit):

```ts
export interface SpawnInitialValues {
  roleId: string; repoId: string;
  taskTitle: string; taskBody: string; targetUrl: string;
  branch: string; withWorktree: boolean;
  model: string | null; permissionMode: string | null;
  optionalArgs: Record<string, boolean>;
  priority: number; scheduledForLocal: string; // '' or 'YYYY-MM-DDTHH:mm'
  exclusive: boolean; dependsOn: string[]; planMd: string;
}
// new props:
initialValues?: SpawnInitialValues | null;            // default null
onEdit?: (p: QueuePayload) => Promise<{ ok: boolean; error?: string }>;
```

- `const isEdit = $derived(initialValues != null)`.
- **Seed state from `initialValues`** via `untrack(...)` for: `selectedRoleId`,
  `selectedRepoId`, `taskTitle`, `taskBodyValue`, `targetUrl`,
  `selectedBranch`, `withWorktree`, `selectedModel`,
  `selectedPermissionMode`, `optArgToggles`, `queuePriority`,
  `queueScheduledForLocal`, `queueExclusive`, `queueDeps`, `queuePlanMd`
  (fall back to today's defaults when `initialValues` is null → create/spawn
  unchanged).
- **Caps-reset effect guard (the tricky part).** The two `$effect`s
  (`SpawnAgentForm.svelte:242` optArgToggles, `:257` model/permissionMode)
  reset to role defaults whenever `selectedRole` is read — on mount this
  would clobber the seeded edit values. Add a per-effect non-reactive tracker
  seeded to the initial role id, e.g. `let optArgsRoleApplied = untrack(() =>
  initialValues ? selectedRoleId : null)` (and `modelCapsRoleApplied`
  likewise). Each effect: `if (tracker === role.id) return;` else set tracker
  and run the existing derive-from-defaults logic. Result: create/spawn mode
  unchanged (tracker starts `null`, effect derives defaults as today); edit
  mode keeps seeded caps on mount but still re-derives correctly when the
  user changes the role.
- **Branch pre-fill fix.** `loadBranches()`
  (`SpawnAgentForm.svelte:206`) unconditionally sets `selectedBranch =
  cached.current ?? cached.branches[0] ?? ''`, which clobbers the seeded
  branch after the async load. Extract a small `pickBranch(cached)`: keep
  `selectedBranch` if it is non-empty **and** in `cached.branches`, else fall
  back to current/first. Behavior-preserving for create (`selectedBranch`
  starts `''`); preserves the seeded branch for edit. *(Intentional, minimal
  behavior change — flagged here.)*
- **Submit routing.** Add `submitEdit()` mirroring `submitQueue()` but calling
  `onEdit(gatherQueuePayload(false))` (the `queued` arg is irrelevant — `PUT`
  ignores it). When `isEdit`: the `<form onsubmit>` (queue branch) calls
  `submitEdit()` instead of `submitQueue(false)`; the actions row renders
  **Cancel + a single primary "Save changes"** button (reusing the existing
  disabled-guards) instead of the Save/Run pair.

### 2. `src/lib/i18n/en.ts` — two new keys (en only; other locales fall back)

```ts
'queue.action.editTask': 'Edit task',   // edit modal title
'queue.action.saveEdit': 'Save changes' // edit submit button
```
(Locale files are `Partial<Record<TranslationKey, string>>` and fall back to
en, so en-only additions are type-safe and sufficient.)

### 3. `src/routes/queue/+page.svelte` — Edit button + edit modal

- DRY the API call: extract a shared helper that serializes a `QueuePayload`
  to the request body (identical 16 fields used by `onQueue`) and is used by
  both create (`POST /api/queue`) and edit (`PUT /api/queue/:id`).
- State: `let editEntry = $state<QueueEntryRow | null>(null)`;
  `function openEdit(e)` sets it; `onClose` clears it. A `rowToInitialValues(e:
  QueueEntryRow): SpawnInitialValues` mapper (parse `optional_args_json` /
  `depends_on_json`; `with_worktree`/`exclusive` `=== 1`; `source_branch ??
  ''`; `plan_md ?? ''`; unix `scheduled_for` → datetime-local via a small
  `toDatetimeLocal()` helper that inverts the form's `parseScheduledFor`).
- `onEditSubmit(payload)`: `apiFetch('/api/queue/'+id, { method:'PUT', ...})`
  via the shared serializer; on `!res.ok` return `{ok:false, error}` (surfaces
  the 409 `queue.error.notEditable` text inside the form); on success clear
  `editEntry` + `await invalidateAll()`.
- Edit dependency options: `editDepOptions = queueDepOptions` minus the entry
  being edited (backend rejects self-dep), **plus** any ids already in its
  `depends_on_json` even if now terminal, so saving doesn't silently drop an
  existing dependency.
- Add an **Edit** button (`{t('queue.action.edit')}`, `class="link"`,
  `onclick={() => openEdit(e)}`) as the first action in `readyActions`,
  `blockedActions`, and `backlogActions` snippets. Do **not** add it to
  `runningActions` or `completedActions`. (Buttons live in `.entry-actions`,
  a sibling of the expand area, so no `stopPropagation` needed — consistent
  with the existing Cancel/Run now buttons.)
- Second `<Modal>` (mirrors the create modal) titled
  `t('queue.action.editTask')`, open when `editEntry !== null`, rendering
  `<SpawnAgentForm mode="queue" ... queueDepOptions={editDepOptions}
  initialValues={rowToInitialValues(editEntry)} onEdit={onEditSubmit}
  onCancel={() => editEntry = null} />`.

## Files to modify

- `src/lib/client/components/SpawnAgentForm.svelte` — props, seeding, effect
  guards, `pickBranch`, edit submit + button.
- `src/routes/queue/+page.svelte` — Edit buttons, edit modal, mapper, shared
  serializer, `onEditSubmit`.
- `src/lib/i18n/en.ts` — `queue.action.editTask`, `queue.action.saveEdit`.
- Tests (below).

No backend changes — `PUT /api/queue/:id` and `coerceQueueInput` are reused
as-is.

## Tests (proposed — per "new features require tests")

1. **NEW `src/routes/api/queue/[id]/server.test.ts`** (server project; no
   queue API tests exist yet). Cover `PUT`: 401 (no user), 404 (missing /
   foreign), 409 for each terminal/running status, 400 (invalid JSON, coerce
   fail, self-dependency), 200 success asserting `updateQueueEntryFields` got
   the mapped fields and `scheduler.scheduleTick()` was called. Follow the
   mock + `call()`-helper pattern in `src/routes/api/roles/server.test.ts`.
2. **Extend `src/routes/queue/page.svelte.test.ts`** (client project): Edit
   button is present for backlog/ready/blocked rows and absent for
   running/completed; clicking it opens a modal containing the form.
3. **NEW `SpawnAgentForm` test** (client project): given `initialValues`,
   inputs are pre-filled (title, priority, model) and the caps-guard keeps the
   seeded model on mount; clicking "Save changes" calls `onEdit` with a
   payload reflecting an edited title.

E2E (Playwright) full round-trip is a reasonable follow-up but optional for
this change (suite is smoke-focused/slower); not blocking.

## Verification

1. `pnpm check` (svelte-check/types) and `pnpm lint` — clean.
2. `pnpm test` — all unit/client green, including the three additions above.
3. `pnpm build` then `pnpm preview`; manually on `/queue`:
   - Create a task (Save → backlog). Backlog row shows **Edit**; running &
     completed rows do not.
   - Edit it: form opens pre-filled (title, role, repo, branch, model,
     priority, schedule, deps, plan). Change the title + priority → **Save
     changes** → modal closes, row reflects the new title; expand shows new
     priority; `updated_at` advances.
   - Edit a **ready/blocked** (queued) task → after save it returns to
     `pending` and the scheduler re-evaluates (expected per existing `PUT`
     contract).
   - Attempting nothing on running/completed (no button) — confirms the 409
     path is unreachable from the UI; the 409 text still surfaces in-form if
     a task races to running while the modal is open.
4. Confirm create/spawn flows are unchanged (no `initialValues` → identical
   behavior).

## Notes / known limitations (out of scope)

- If a task's saved `role_id` is no longer in the page's (agentic-CLI-filtered)
  roles list, the role `<select>` can't represent it — pre-existing concern
  for any removed role, not introduced here.
- After approval: `git mv` this plan to its branch-matching name per the
  global plan conventions, and update project `CLAUDE.md`'s task list after a
  successful build.
