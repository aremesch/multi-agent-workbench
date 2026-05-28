# fix-title-taken-error

> Rename after approval: `git mv when-starting-the-task-flickering-hare.md fix-title-taken-error.md`

## Context

Two related defects in the spawn pipeline:

1. **The immediate bug** — starting the queued task `polyrepo-support` fails
   with the messagebox "Title already used — pick a different one", even
   though no live agent or worktree currently uses that slug. Investigation
   of `maw.db` shows a stale `worktrees` row at
   `/home/maw/.local/share/maw/worktrees/polyrepo-support` with status
   `removed`. The collision check in
   `src/lib/server/agents/spawnFromInputs.ts:308` calls
   `findWorktreeByPath` without filtering by status, so a tombstone row
   permanently locks the slug. The on-disk dir is gone, so `existsSync`
   would not have tripped — the DB row alone is the gate.

2. **A contradiction in uniqueness rules** — the queue accepts unlimited
   queue entries sharing a title (no DB constraint on
   `queue_entries.title`, no app-level check in `POST /api/queue`), but the
   worktree slug derived from that title must be unique on the filesystem.
   The user only finds out at spawn time, when the scheduler tick promotes
   the entry to `running` and `performSpawn` returns `titleTaken`. The
   error is classified `soft` so the entry retries forever, masking the
   real problem.

The fix narrows the collision check so terminal worktrees stop blocking,
and adds an up-front uniqueness check so users learn about a collision
the moment they submit the form, not silently on a future scheduler tick.

Scope of "in use" (per user direction): only non-terminal queue entries,
active agents, and `active`/`orphaned` worktrees count. `done`,
`failed`, `cancelled` queue entries and `removed` worktrees do not.

The companion bug about Claude Code agents misreported as `WAITING_INPUT`
while actively running is **out of scope** here — it gets its own plan
and branch.

## Approach

### 1. Tighten the collision check at spawn time

`src/lib/server/agents/spawnFromInputs.ts:306-310`

Replace the unconditional `findWorktreeByPath` lookup with one that
ignores `status = 'removed'` rows. Either:

- inline filter:
  ```ts
  const existing = findWorktreeByPath(targetPath);
  if ((existing && existing.status !== 'removed') || existsSync(targetPath)) {
    return { ok: false, error: { code: 'titleTaken' } };
  }
  ```
- or add a focused helper `findActiveWorktreeByPath(path)` in
  `src/lib/server/db/queries.ts` next to `findWorktreeByPath` (line 285)
  that selects `WHERE path = ? AND status != 'removed'`. Preferred —
  intent is explicit and other callers of `findWorktreeByPath` keep
  their full-table view.

`existsSync` still guards against a re-used dir from a process that
crashed before recording in the DB.

### 2. Reject duplicate titles at save time

Add a new validation step run alongside (not inside) `validateSpawnInputs`
so it fires at the API/form boundary, where we have the user id needed
to scope the check. The slug — not the raw title — is what must be
unique, since "Polyrepo Support" and "polyrepo-support" collide on disk.

New helper in `src/lib/server/db/queries.ts`:

```ts
// Returns true if `slug` is currently claimed by something the spawn
// pipeline cannot share with: a live queue entry, a live agent's
// worktree, or a non-removed worktree row at that path.
export function isSlugInUse(userId: string, slug: string, worktreeRoot: string): boolean
```

Implementation — three small queries OR-ed together, all filtered by
`user_id`:

- `queue_entries` where `status IN ('pending','blocked','ready','running')`
  AND `slugifyTitle(title) === slug` — done in-memory over the user's
  non-terminal entries (`listSchedulableQueueEntries`). Queue sizes are
  small enough that a SQL slug column is not worth its complexity (NFKD
  normalization can't run in pure SQL → would need a custom backfill
  path). Revisit if the queue grows large.
- `worktrees` where `path = join(worktreeRoot, slug)` AND
  `status != 'removed'`.
- The exclusion intentionally does not query `agents` separately —
  every running agent has a `worktrees` row, and the worktree check
  already covers it.

Call sites:

- `src/routes/api/queue/+server.ts` POST handler, right after
  `validateQueueInput` (line ~82) succeeds. On collision return
  `409` with `t(locals.locale, 'spawn.error.titleTaken')`. Mirror in
  the PUT handler if it allows title changes.
- `src/routes/agents/new/+page.server.ts` action, right after
  `validateSpawnInputs` succeeds (line ~140), before `performSpawn`.
  Same 409 + `spawn.error.titleTaken`.
- The scheduler's promote path keeps the existing `performSpawn`
  check as the last line of defense — race against another tab is
  rare but possible. No change there beyond §1.

The error code, i18n key, and frontend toast already exist — only the
detection point moves earlier. No new strings.

### 3. Recovery for the existing `polyrepo-support` blockage

Once §1 ships, the blocked `polyrepo-support` queue entry will promote
on the next scheduler tick
because the only collider is the `removed` worktree row. No manual
intervention needed.

If the user wants the stale row gone for hygiene, a one-off SQL is
safe:

```sql
DELETE FROM worktrees
 WHERE status = 'removed'
   AND path = '/home/maw/.local/share/maw/worktrees/polyrepo-support';
```

Optional follow-up (not in this plan): a periodic cleanup that removes
`removed` worktrees older than N days.

## Files to modify

- `src/lib/server/agents/spawnFromInputs.ts` — switch to
  `findActiveWorktreeByPath` (§1).
- `src/lib/server/db/queries.ts` — add `findActiveWorktreeByPath`
  and `isSlugInUse` (§1, §2).
- `src/routes/api/queue/+server.ts` — call `isSlugInUse` in POST
  (and PUT when title changes) and return 409 on collision (§2).
- `src/routes/agents/new/+page.server.ts` — call `isSlugInUse` after
  `validateSpawnInputs` (§2).

No i18n changes. No frontend changes — the toast already handles a 409
on these endpoints.

## Tests

- Unit: `slugifyTitle` collision cases (`"Polyrepo Support"` vs
  `"polyrepo-support"` resolve to same slug).
- Unit / integration on `isSlugInUse`: returns true for non-terminal
  queue entries, true for active/orphaned worktrees, **false** for
  `removed` worktrees and terminal queue entries.
- Integration on `POST /api/queue`: second insert with same slug
  returns 409 + `spawn.error.titleTaken`; same title with a different
  case still rejected.
- Regression: `performSpawn` still returns `titleTaken` when the
  worktree dir exists on disk without a DB row (orphan covers the
  crash-before-record case).

## Verification (manual)

1. Start the dev server.
2. Confirm the `polyrepo-support` queue entry promotes on the next
   tick after restart (no code change needed beyond §1).
3. Submit two new queue entries with title `Demo Task` back-to-back.
   The second submission must show "Title already used — pick a
   different one" inline on the form and not create a queue entry.
4. Submit a queue entry whose title slugifies the same as an existing
   one (`"Demo  Task!"` vs `"demo-task"`). Same rejection.
5. Cancel the first `Demo Task` entry, then re-submit. Acceptance
   should succeed — terminal entries don't block.
6. Optional: with §3's cleanup SQL applied, verify no orphan rows
   remain at the test slug path.
