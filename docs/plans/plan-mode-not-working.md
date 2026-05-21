# Plan: ensure `--permission-mode <picked>` is always passed to claude-code

## Context

**Reported bug:** when a backlog task is created with permission mode = "Plan"
and then promoted via the /queue UI, the spawned claude-code agent shows
"bypass-permissions mode" inside its own TUI. The user expects to see plan
mode and asks that `claude --permission-mode plan` (or whatever was picked)
be passed on the command line.

**What the code does today:** the pipeline already appends
`--permission-mode <picked>` whenever the adapter declares a `permissionMode`
capability and the picked value is non-empty.

Flow (queue → run-from-backlog path the reporter used):

1. Spawn dialog → POST `/api/queue` with `permission_mode: 'plan'`
   (`src/routes/api/queue/+server.ts:101`).
2. `validateSpawnInputs` runs `sanitizeCapabilityValue` against the adapter
   capability — 'plan' is in the allowed list so it stays 'plan'
   (`src/lib/server/agents/spawnFromInputs.ts:236-239`).
3. Stored on `queue_entries.permission_mode` (migration
   `migrations/010_queue_entries.sql:37`).
4. User clicks "Queue" → POST `/api/queue/:id/queue` flips `queued=1`
   (`src/routes/api/queue/[id]/queue/+server.ts`); `permission_mode` is
   untouched.
5. Scheduler picks the entry, reads `entry.permission_mode` and feeds it
   back into `validateSpawnInputs`
   (`src/lib/server/queue/Scheduler.ts:490`).
6. `performSpawn` → `supervisor.spawn` → `adapter.buildSpawnSpec` with
   `capabilityValues: { permissionMode: 'plan' }`
   (`src/lib/server/agents/AgentSupervisor.ts:576-592`).
7. `ConfigDrivenAdapter.appendCapabilityArg('permissionMode', 'plan')`
   pushes `['--permission-mode', 'plan']` into `spec.args`
   (`src/lib/server/agents/adapters/ConfigDrivenAdapter.ts:204-219`).
8. `Tmux.newSession` exec-quotes every arg into the shell line
   (`src/lib/server/tmux/TmuxSession.ts:101-102`).

Running the buildSpawnSpec logic by hand against the real
`cli-adapters/claude-code.jsonc` with `capabilityValues.permissionMode = 'plan'`
produces:

```
claude --session-id <uuid> --model default --permission-mode plan "<body>"
```

So the pipeline is correct in isolation. We need to (a) lock that in with
a regression test that uses the **real** adapter config, and (b) make the
actual argv visible at runtime so a future report doesn't require a code
read to verify. If, with both in place, the reporter still sees bypass
mode in the TUI, the cause is downstream of MAW (e.g. a `~/.claude/`
preference or a prior version of the row in the DB with a stale
`permission_mode`).

## Approach

### 1. Regression test using the real `cli-adapters/claude-code.jsonc`

Add a new test in `src/lib/server/agents/adapters/ConfigDrivenAdapter.test.ts`
(or a new sibling `claude-code-permission-mode.test.ts`) that:

- Loads `cli-adapters/claude-code.jsonc` through `AdapterRegistry.loadAll`
  (which is what production uses), not a hand-rolled fixture.
- Creates a `ConfigDrivenAdapter` via `registry.create('claude-code')`.
- Calls `buildSpawnSpec` for each of the four `permissionMode.values` ids
  (`plan`, `default`, `acceptEdits`, `bypassPermissions`).
- Asserts that consecutive tokens `'--permission-mode'` followed by the
  picked id appear in `spec.args`.
- Also asserts the same when `capabilityValues.permissionMode` is `null`
  (must fall back to the adapter's default `'plan'`).

This nails down the contract end-to-end: real config + real registry +
real adapter class.

### 2. Higher-level test through `spawnFromInputs`

Extend `src/lib/server/agents/spawnFromInputs.test.ts` (it already exists)
with a case that:

- Uses a real `AdapterRegistry` loaded from `cli-adapters/`.
- Calls `validateSpawnInputs` with `permissionMode: 'plan'` and a
  claude-code role whose `default_permission_mode` is `null`.
- Confirms `validation.value.permissionMode === 'plan'` survives
  validation.

This catches a regression where `sanitizeCapabilityValue` or the schema
silently nulls the field.

### 3. Log the spawn argv

In `src/lib/server/agents/AgentSupervisor.ts` just before the
`Tmux.newSession` call (around line 668), add:

```ts
console.log(
  `[AgentSupervisor] spawn ${agentId} (${role.cli_kind}): ` +
  `${spec.command} ${spec.args.map((a) => JSON.stringify(a)).join(' ')}`
);
```

(`env` is intentionally omitted — it contains `ANTHROPIC_API_KEY`.) The
existing supervisor already logs at this level for reattach paths, so the
format is consistent.

This is the cheapest possible "post-mortem" tool: the user (or we) can
`journalctl -u maw` after a spawn and see the exact argv claude was
launched with.

### Files

- `src/lib/server/agents/adapters/ConfigDrivenAdapter.test.ts` — add real-config test
- `src/lib/server/agents/spawnFromInputs.test.ts` — add validation passthrough test
- `src/lib/server/agents/AgentSupervisor.ts:668` — add one-line spawn log

No production logic changes. If the regression tests fail (i.e. there
**is** a real bug I missed), this plan is paused and the failure
pinpoints the fix.

## Verification

1. `pnpm vitest run src/lib/server/agents/adapters/ConfigDrivenAdapter.test.ts src/lib/server/agents/spawnFromInputs.test.ts` — both new cases green.
2. `pnpm build` — type-check clean.
3. Spawn a claude-code agent through `/queue` (Save → Backlog → Queue) with
   permission mode "Plan". Check the server log: the spawn line must
   contain `--permission-mode plan`. Then `ps -ef | grep claude` on the
   host: same flag must be in the live argv.
4. Inside the claude TUI, the footer / mode indicator should show plan
   mode rather than bypass mode.

## Resolution

`ps -ef | grep claude` on the running install showed the actual culprit:

```
claude --session-id … --model opus --permission-mode plan --dangerously-skip-permissions
```

Both `--permission-mode plan` AND `--dangerously-skip-permissions` were
being passed. Claude Code resolves that conflict by treating the dangerous
flag as more permissive, so the TUI showed "bypass permissions on".

Source: the user's `user_settings` table had a stored spawn-default
`spawn.defaults.claude-code = {"optionalArgs":{"skip-permissions":true}}`
from an earlier toggle. The spawn dialog pre-checked that hidden Advanced
toggle on every claude-code spawn, regardless of the visible Permission
mode dropdown.

**Fix:** removed the `skip-permissions` optional arg from
`cli-adapters/claude-code.jsonc`. The capability dropdown's
`bypassPermissions` value already covers the same behaviour, and shipping
both controls invited the silent override. The stored
`{"skip-permissions": true}` setting becomes an orphan key (the spawn form
only iterates adapter-declared optional args), so existing installs
heal automatically with no migration needed.
