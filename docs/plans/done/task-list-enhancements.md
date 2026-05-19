# Task List Enhancements

> After approval, rename this file to `task-list-enhancements.md` via `git mv`
> (matches branch/worktree name, per repo plan conventions).

## Context

The Tasks dashboard (`/queue`) has five rough edges reported by the user:

1. **"Agent öffnen" is broken.** The queue links to `/agents/[id]`, a bare page
   that renders only the xterm terminal — no modal caption, no kebab menu, so
   there is no way to open the agent's Plan or Log. The full experience
   (Modal + caption + ⋮ → Show Plan / Show Log / Exit) exists only on
   `repos/[id]`.
2. **Noisy header.** A redundant headline + explanatory subtitle and a
   non-functional "1 / 1" counter (actually the concurrency limits) sit atop
   the list.
3. **Cramped edit dialog.** The edit-task dialog is a fixed 28 rem single
   column, forcing lots of vertical scrolling.
4. **Bulky per-row actions.** Each task row shows 3–4 inline link buttons that
   wrap into a tall block on mobile; not M3-compliant.
5. **No way to attach screenshots.** Tasks cannot carry image attachments to
   give the coding agent visual context.

Approved decisions (asked & answered):

- **(1)** Extract one **shared in-place modal** (DRY); queue, repo page, and the
  `/agents/[id]` route all use it.
- **(5)** **Auto-reference in prompt**: stage files with the task, copy into the
  agent worktree at run time, append `@<path>` refs to the prompt — mirrors the
  existing paste-image-into-agent flow. Supported on new **and** edited tasks.
- **(4)** Build one **shared M3 OverflowMenu** and **refactor `AgentMenu`** onto
  it; reuse it for task rows.

Intended outcome: a compact, M3-compliant task list with a working agent
window, a roomy edit dialog, and image attachments that reach the agent.

## Build order (dependency-aware)

Phases 1–4 are the UI refactor; Phase 5 is the attachments feature (largely
independent of 1–4 but shares the queue page and `SpawnAgentForm`).

---

### Phase 1 — Shared `OverflowMenu` (request 4)

**New:** `src/lib/client/components/OverflowMenu.svelte`

- Data-driven items API (not snippet children) — both consumers have a
  homogeneous item list; a snippet API would re-duplicate roles/targets/state.
  ```ts
  interface OverflowMenuItem {
    id: string; label: string; icon?: Snippet;
    onSelect?: () => void; href?: string;
    disabled?: boolean; destructive?: boolean; dividerBefore?: boolean;
  }
  props: { items: OverflowMenuItem[]; label: string;
           align?: 'start' | 'end'; trigger?: Snippet }
  ```
- Port behavior from `AgentMenu.svelte`: `aria-haspopup="menu"`/`aria-expanded`
  trigger; `role="menu"` + `role="menuitem"`; `<svelte:window onclick onkeydown>`
  outside-click + Escape close (focus returns to trigger); disabled items get
  both `disabled` and `aria-disabled="true"` and swallow the click; `href`
  items render `<a role="menuitem">`; `dividerBefore` → `<hr>` (not a menuitem).
- **M3 compliance** — replace all hardcoded hex with `src/app.css` tokens:
  surface `--md-sys-color-surface-container`, border
  `--md-sys-color-outline-variant`, radius `--md-sys-shape-corner-sm`, shadow
  `--md-sys-elevation-level-2`; text `--md-sys-color-on-surface`, destructive
  `--md-sys-color-error`; hover/focus 8% state layer
  (`color-mix(... on-surface 8%, transparent)`), destructive hover 12% error;
  disabled `opacity:0.38`; **menu items `min-height:48px`** (touch target);
  existing motion tokens. No Tailwind utility classes.

### Phase 2 — Refactor `AgentMenu` onto `OverflowMenu`

**Edit:** `src/lib/client/components/AgentMenu.svelte`

- Keep its prop signature **unchanged** (consumers untouched). Replace markup +
  styles with a thin wrapper that builds an items array (Show Plan, Show Log,
  divider, Exit Agent — `destructive`, `disabled` when
  `status ∈ {exited,crashed}`) and renders `<OverflowMenu>`. Inline SVGs passed
  as per-item `{#snippet}` icons.
- **Gate:** `src/lib/client/components/AgentMenu.test.ts` must pass **with zero
  edits** (label `agentMenu.button`; no `menu` role until open; 3 menuitems;
  Escape/outside-click close; callbacks fire once; disabled Exit has
  `disabled`+`aria-disabled` and swallows click). This is the parity check.

### Phase 3 — Shared `AgentWindowModal` (request 1)

**Server load enrichment (do first):**

- **`src/lib/server/db/queries.ts`** — add `getAgentCard(id): AgentCardRow |
  undefined` and `listAgentCardsByIds(userId, ids[]): AgentCardRow[]`, reusing
  the exact join/column list of `listAgentCardsForUser` (roles/repos/projects/
  tasks) but **without the live-status filter** (archived/completed agents must
  resolve), `WHERE a.user_id = ?` for ownership; bound the `IN (...)` arity like
  the existing query. Do **not** delete/alter `getQueueConcurrency`.
- **`src/routes/agents/[id]/+page.server.ts`** — return `getAgentCard(params.id)`
  (full card: + `project_name`, `role_name`, `task_title`), keeping the
  `user_id`/404/403 guards.
- **`src/routes/queue/+page.server.ts`** — add
  `agentsById: Record<string, AgentCardRow>` built from the non-null
  `agent_id`s via `listAgentCardsByIds`; **remove** the `concurrency` field and
  the `getQueueConcurrency` call (Phase 4 drops its only consumer).

**New:** `src/lib/client/components/AgentWindowModal.svelte` — encapsulates the
pattern currently inlined in `repos/[id]/+page.svelte` (state 38–46, handlers
48–96, `statusBadge` 182–196, Modal 198–220, Plan/Log/Confirm/exit-error
222–259, `.status*`+`.exit-error*` CSS 297–353):

```ts
props: { agent: AgentCardLike | null; open: boolean;
         onClose: () => void; onArchived?: () => void }
```
Owns `openAgentStatus/planOpen/logOpen/exitConfirmOpen/exitErrorMsg`, the
`POST /api/agents/{id}/stop` call (409 = no-op success), an `$effect` resetting
status from `agent.status`, and an `$effect` calling `onArchived?.()` on
`exited`/`crashed`. Renders `<Modal title={"Project/Task — Role — cli"}
headerRight={openAgentStatus ? statusBadge : undefined}>` →
`{#key agent.id}<AgentTerminalPanel/>{/key}`; `statusBadge` = `<AgentMenu>`
(gated by `isCodingCliKind`) + status pill; conditional `<PlanViewerModal
source={{kind:'agent',agentId}}>`, `<ArchivedAgentLogModal title={t('agent
.logTitle',{name})}>`, `<ConfirmDialog>`, exit-error alert. Status-pill CSS
moves here.

**Edit consumers:**

- `src/routes/repos/[id]/+page.svelte` — replace the inlined agent modal region
  with `<AgentWindowModal agent={openAgent} open={openAgent!==null}
  onClose={closeModal} onArchived={() => invalidateAll()} />`. **Keep**
  `openAgent`/`onOpen`/`closeModal`/`syncAgentParam`/the `?agent=` deep-link
  `$effect`/`ackAgentAlerts` and the unrelated spawn `<Modal>`. Drop now-unused
  imports (grep-verify; `Modal` stays — spawn uses it).
- `src/routes/agents/[id]/+page.svelte` — replace bare `<AgentTerminalPanel>`
  with `<AgentWindowModal agent={data.agent} open={true}
  onClose={() => goto('/')} onArchived={() => goto('/')} />`.

### Phase 4 — Queue page integration (requests 1-wiring, 2, 4)

**Edit:** `src/routes/queue/+page.svelte`

- **Header removal (req 2):** delete the whole `<header class="page-head">`
  (355–373: h1, subtitle, `.concurrency-summary` "1 / 1"). When `repoFilter` is
  set, render only a minimal `<p class="filter-note">{queue.filteredByRepo}
  · <a class="link" href="/queue">{queue.showAll}</a></p>`; nothing when
  unfiltered. Remove `const concurrency = $derived(...)` (26) and CSS
  `.page-head/.subtitle/.head-actions/.concurrency-summary` (+ the mobile
  `.page-head` rule). Keep `<svelte:head><title>` and per-section
  `<h2>…(count)</h2>`.
- **Kebab rows (req 4):** replace the five inline action snippets (486–544)
  with one `<OverflowMenu label={t('queue.action.rowMenu')} align="end">` per
  row, items per status reusing existing handlers: running → Open agent,
  Cancel(destructive); ready/blocked → Edit, Run now, Send to backlog,
  Cancel(destructive); backlog → Edit, Queue, Run now, Cancel(destructive);
  completed → Open agent (hide when no `agent_id`). Label-only items (no icons)
  to keep scope tight. Simplify `.entry-actions` mobile CSS (954–965) so the
  kebab stays inline-right; keep `.link` base styles (filter-note uses it).
- **Agent modal wiring (req 1):** import `AgentWindowModal`; add
  `let openAgentId = $state<string|null>(null)` and
  `const openAgent = $derived(openAgentId ? data.agentsById[openAgentId] ??
  null : null)`. "Open agent" item sets `openAgentId = e.agent_id`. Render once
  near the existing `PlanViewerModal`: `<AgentWindowModal agent={openAgent}
  open={openAgent!==null} onClose={() => openAgentId=null}
  onArchived={() => { openAgentId=null; invalidateAll(); }} />`.

### Phase 5 — Wider edit dialog (request 3)

**Edit:** `src/lib/client/components/SpawnAgentForm.svelte` — gate strictly on
the existing `mode === 'queue'` (spawn callers omit `mode` → **zero
regression**):

- `.wrap` base stays `width:28rem`. Add `class:wide={mode==='queue'}` and
  `.wrap.wide{width:min(56rem,92vw)}` (within `Modal`'s 96vw cap).
- Mobile-first single column; `@media (min-width:640px){ .wrap.wide form{
  grid-template-columns:1fr 1fr } }`. Add `.span-2` (defined only under
  `.wrap.wide form` at ≥640px) on full-width blocks: task title/body, plan
  `<details>`, dependency picker, inline new-repo form, error line,
  actions-hint, `.actions` row, and the `queue-extras` fieldset (lays
  priority+scheduled side by side internally). Pair Role+Repo,
  Branch+model/permission as two-up. Verify each block by reading the form
  markup so textareas always span.

---

### Phase 6 — Image attachments on tasks (request 5)

**a. DB.** New `migrations/012_queue_entries_attachments.sql`:
`ALTER TABLE queue_entries ADD COLUMN attachments_json TEXT NOT NULL DEFAULT
'[]';` (constant default → safe `ADD COLUMN` in SQLite; existing rows backfill).
Record shape: `{ filename, mime, size, stagedPath }` (no `relativePath` — that
is ephemeral, assigned at materialization).
- `src/lib/server/db/types.ts` — add `attachments_json: string` to
  `QueueEntryRow`.
- `src/lib/server/db/queries.ts` — add `attachments_json` to
  `InsertQueueEntryInput`/`insertQueueEntry` (column+placeholder+arg),
  `UpdateQueueEntryFieldsInput`/`updateQueueEntryFields` (`push(...)`); add
  `setQueueEntryAttachments(id,userId,json): boolean`
  (`UPDATE … SET attachments_json=?, updated_at=? WHERE id=? AND user_id=?`).
  All queue SELECTs are `SELECT *` — no enumeration changes.

**b. Server upload modules (DRY).**
- New `src/lib/server/uploads/imageUploadCore.ts` — move location-agnostic core
  out of `agentImageUploads.ts`: `ALLOWED_MIME`, `EXT_BY_MIME`, `MAX_BYTES`,
  `ValidationResult`, `validateUpload`, `generateFilename`. `agentImageUploads
  .ts` re-exports them (existing imports/tests unchanged); it keeps
  `UPLOADS_SUBDIR`, `ensureMawGitignore`, `writeAgentImage`.
- New `src/lib/server/uploads/taskAttachmentUploads.ts`:
  `stagingDirFor(taskId)` = `resolve(getConfig().dataDir,'task-uploads',
  taskId)` (traversal-guard taskId); `stageTaskAttachment(taskId,mime,bytes,
  opts?)` (mkdir 0o700, write 0o600, traversal guard) → `TaskAttachmentRecord`;
  `parseAttachments(json)` (defensive); `deleteStagedAttachment(taskId,
  filename)`; `deleteAllStaged(taskId)` (idempotent, swallow ENOENT);
  `materializeIntoWorktree(records,worktreePath)` → reuses `ensureMawGitignore`
  + `UPLOADS_SUBDIR`, copies to `<wt>/.maw/uploads/`, returns `@<rel>` refs;
  `pruneOrphanStagingDirs()` (startup GC).

**c. API routes** (mirror `src/routes/api/agents/[id]/upload-image/+server.ts`:
`verifyCsrf`, auth, `getQueueEntryForUser` owner check, 409 if status terminal):
- New `src/routes/api/queue/[id]/attachments/+server.ts` — `POST` (multipart
  single `file`, `validateUpload`, `stageTaskAttachment`, append to list,
  **max 10/task** → 400 + cleanup, `setQueueEntryAttachments`, return
  `{filename,sizeBytes,mime}` — never the staging path); `GET` (list metadata).
- New `src/routes/api/queue/[id]/attachments/[filename]/+server.ts` — `DELETE`
  (validate filename charset, `deleteStagedAttachment`, rewrite list).
- **Sequencing:** uploads happen **after** the row write, for both create and
  edit (upload-on-save). `onQueue`/`onEdit` return `{ok, error?, id?}`; the
  queue page then POSTs pending files / DELETEs removed ones. Create-then-upload
  partial failure → keep the task, show non-fatal toast
  (`queueAttachments.partialFailure`), task editable for retry. Never
  auto-delete a saved task.

**d. Scheduler / spawn injection — guarantee the agent receives the images.**

The hand-off is two independent guarantees; **both** must hold for every
coding adapter (do not silently skip non-cli-arg adapters):

1. **Bytes on disk in the agent's cwd.** In `performSpawn`, **after**
   `worktreePath` is resolved and **before** `spawnArgs` is built, whenever
   `adapterSupportsWorktree && attachments.length` (regardless of
   `initialInputDelivery`): `refs = await materializeIntoWorktree(attachments,
   worktreePath)` — copies into `<wt>/.maw/uploads/` (or repo root for the
   worktree-opted-out git case). The files are physically present where the
   agent runs, even if reference delivery later fails.
2. **Reference handed to the agent**, routed by how that adapter receives its
   initial prompt (mirror the body's own delivery channel so refs ride exactly
   the path the body rides):
   - **cli-arg adapters** (`initialInputDelivery==='cli-arg'`): append
     `\n\nAttached files:\n<refs joined by space>` to the composed body and use
     that final body for `spawnArgs.task.body` + the task-row insert. Ordering:
     body → plan → attachment refs. No startup race (part of the first prompt).
   - **interactive / non-cli-arg coding adapters** (body delivered by typing
     into the tmux pane after spawn): reuse the **proven paste-into-agent
     mechanism** — after the pane/agent is ready, `sendKeys(agentId,
     ' @<rel1> @<rel2> ')` (the same WS/tmux path
     `AgentTerminalPanel.uploadAndInjectImage` uses). Locate where the existing
     code delivers the initial body for these adapters and append the refs to
     that same post-spawn delivery so timing is identical to the body's.
   - **adapters with no agent / no prompt channel** (browser, pure shell):
     attachments are not offered (UI hides the picker — step e) and not
     materialized. Defense-in-depth only; the user can never reach this.
- `src/lib/server/agents/spawnFromInputs.ts` — add `attachments:
  TaskAttachmentRecord[]` to `RawSpawnInputs`/`ValidatedSpawnInputs` (default
  `?? []` so the synchronous `/agents/new` path needs no change); leave
  `composeBodyWithPlan` (body+plan) untouched — refs are appended after, per
  the routing above.
- `src/lib/server/queue/Scheduler.ts` — in `promoteOne` pass `attachments:
  parseAttachments(entry.attachments_json)`; delete staging **only after the
  reference is confirmed delivered** (cli-arg: after `performSpawn` ok;
  interactive: after the post-spawn `sendKeys`) via
  `await deleteAllStaged(entry.id).catch(()=>{})`. On spawn failure **or**
  failed ref delivery, **keep** staging (retry) and record `last_error` so the
  user knows the images did not reach the agent — never report success while
  the agent is missing its attachments.
- `src/routes/api/queue/_payload.ts` — `validateQueueInput` sets
  `attachments: []` (attachments are uploaded separately, not in the JSON
  payload — queue payload contract unchanged).

**e. UI in `SpawnAgentForm.svelte`** (reuse `AgentTerminalPanel.svelte` paste
patterns: `IMAGE_MIMES`, 5 MiB mirror, hidden multi `<input type=file>`):
- New optional props `existingAttachments?` and
  `onAttachmentsCommit?(taskId, pending: File[], removed: string[])`. State:
  `pendingFiles`, `existing`, `removedFilenames`, `attachError`. Render the
  block only when `mode==='queue'` and the adapter takes a prompt (reuse
  `showTaskBody`). Client-side mirror of `validateUpload` + 10-file cap; M3
  thumbnail chips (`URL.createObjectURL` for pending; generic chip for existing)
  with remove. `onQueue`/`onEdit` return `id`; after save call
  `onAttachmentsCommit`. Queue page passes `existingAttachments` (from
  `parseAttachments(editEntry.attachments_json)`) on edit and implements
  `commitAttachments` (sequential POST/DELETE, non-fatal failure toast).

**f. Cleanup/GC.** `deleteAllStaged` on: `Scheduler.cancelEntry` (after status
→ cancelled), the DELETE route's cancel path, any hard-delete call site, and
after successful promote (d). Startup `pruneOrphanStagingDirs()` from scheduler
bootstrap (best-effort, logged). Failed/blocked tasks retain staging for retry
by design.

---

## Critical files

New: `OverflowMenu.svelte`, `AgentWindowModal.svelte`,
`imageUploadCore.ts`, `taskAttachmentUploads.ts`,
`migrations/012_queue_entries_attachments.sql`,
`api/queue/[id]/attachments/+server.ts`,
`api/queue/[id]/attachments/[filename]/+server.ts`.

Edited (high-touch): `src/routes/queue/+page.svelte`,
`src/lib/client/components/SpawnAgentForm.svelte`,
`src/lib/server/db/queries.ts`, `src/lib/server/agents/spawnFromInputs.ts`,
`src/lib/server/queue/Scheduler.ts`.

Edited (secondary): `AgentMenu.svelte`, `repos/[id]/+page.svelte`,
`agents/[id]/+page.svelte`, `agents/[id]/+page.server.ts`,
`queue/+page.server.ts`, `db/types.ts`, `api/queue/_payload.ts`,
`api/queue/+server.ts`, `src/lib/i18n/{en,de}.ts`.

## Tests

- New unit: `OverflowMenu.test.ts`, `imageUploadCore.test.ts`,
  `taskAttachmentUploads.test.ts`. New route: `api/queue/[id]/attachments/
  server.test.ts`.
- Update: `AgentMenu.test.ts` must stay green **unchanged** (parity gate);
  `queue/page.svelte.test.ts` (drop `concurrency`, add `agentsById:{}`, drive
  actions via the kebab, add Open-agent modal test, mock `AgentTerminalPanel`
  per existing pattern); `api/queue` route/payload tests + any `RawSpawnInputs`
  fixtures (`attachments:[]` or rely on default); `Scheduler.test.ts` —
  assert the **hand-off guarantee** for *both* routes: cli-arg adapter →
  files in worktree **and** prompt body contains `@.maw/uploads/...`;
  interactive adapter → files in worktree **and** post-spawn `sendKeys`
  called with the `@<rel>` refs; staging deleted only after delivery;
  staging **retained** + `last_error` set on spawn/delivery failure.
- i18n: add `queue.action.rowMenu`, `queueAttachments.*` to **both**
  `en.ts`/`de.ts` (identical key sets).

## Verification

1. `npm run migrate` on a copy of an existing DB → `attachments_json` present,
   old rows `'[]'`.
2. `pnpm check` clean (catches type changes from new queries / dropped
   `concurrency` / widened return type).
3. `pnpm test` (gate order: AgentMenu green → OverflowMenu → queue page),
   `pnpm test:integration` (Scheduler materialization).
4. `pnpm dev` manual:
   - Queue: no h1/subtitle/"1 / 1"; filtered view still shows "… · Show all".
   - Row kebab: M3 menu, correct actions, red Cancel, ≥48px, closes on
     outside-click/Escape, works <600px.
   - "Open agent" (running) opens the **in-place** shared modal with caption +
     ⋮ (Show Plan/Log/Exit); Exit→confirm→409-safe stop.
   - Direct `/agents/<id>` and `repos/[id]` agent-open both use the same modal
     (regression check).
   - Edit dialog wide & 2-column ≥640px; **spawn dialog still 28rem single
     column** (dashboard + repos/[id]).
   - Attach 2 images → save → reopen edit (chips) → add/remove → save →
     promote → agent prompt contains `@.maw/uploads/...` and files in worktree.
   - Browser-adapter task: attachments picker hidden, no materialization.
   - Interactive (non-cli-arg) coding adapter: files land in the worktree
     **and** the refs are typed into the session post-spawn (agent sees them).
5. Edge cases: oversize/wrong-mime/CSRF/owner-mismatch/terminal-status (409)/
   >10 files/task-deleted-mid-stage; spawn/delivery failure leaves staging +
   `last_error` (no false success); `BODY_SIZE_LIMIT` ≥ `MAW_IMAGE_MAX_BYTES`
   deployment note (same as `upload-image`).

## Risks

- **Shared `SpawnAgentForm`** — wide layout + attachments gated on
  `mode==='queue'`; new props optional; return-type widening additive. Verify
  no spawn caller passes `mode="queue"`.
- **Shared `AgentMenu`** — signature unchanged; `AgentMenu.test.ts` is the net.
  OverflowMenu must render divider as `<hr>` (not a menuitem) and set both
  `disabled`+`aria-disabled` on disabled items.
- **Queue server load** — `listAgentCardsByIds`/`getAgentCard` must **not**
  status-filter (completed rows reference exited agents); `WHERE user_id`
  prevents cross-user leakage.
- **`getQueueConcurrency`** — remove only the queue-load *call*, never the
  query (other consumers); grep before deleting.
- **Migration / column enumeration** — only INSERT + dynamic UPDATE enumerate
  columns; SELECTs use `*`.
- **Hand-off must not silently drop** — materialization gated on
  `adapterSupportsWorktree` alone (NOT cli-arg); reference delivery routed per
  adapter (cli-arg → prompt body; interactive → post-spawn `sendKeys`). Only
  browser/no-agent adapters skip — and the UI never offers attachments there.
  Delivery failure ⇒ keep staging + `last_error`, never a false "running".
- **Staging disk growth** — cancel/success cleanup + startup prune; failed
  tasks retain for retry by design.
- **Security** — server-generated filenames only; traversal guard on
  stage/materialize/delete; 0o700 dir / 0o600 files; CSRF + auth + owner on
  every route; staging path never returned to client.

## Post-approval

`git mv docs/plans/mellow-stirring-anchor.md
docs/plans/task-list-enhancements.md` before starting implementation.
