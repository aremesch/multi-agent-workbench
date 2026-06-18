# Plan: Fix the wedged "start-project" agent (dossier) — resilient agent teardown

## Context

The user created a **start-project** queue entry in the **dossier** repo (a
fresh repo, `claude-code` role `dev-claude`, `with_worktree=0` so it runs in
the repo root). The agent **failed to start** and is now stuck — the user
cannot Stop it, and the task never runs.

### What actually happened (established from the live install: `~/.local/share/maw/maw.db` + journald)

- Agent `01KVCNC79TWD3AH7FG1TR659T6` (claude-code, dossier) is at status
  `spawning` with **`created_at == updated_at`** — the row was never updated
  after insert. There is **no `agent_runs` row** and **no `terminal_log`**.
  So `AgentSupervisor.launchCliRuntime()` never reached
  `insertAgentRun` / `updateAgentStatus('running')`
  (`src/lib/server/agents/AgentSupervisor.ts:812-818`). claude did launch (it
  seeded its `CLAUDE_CONFIG_DIR`) but never became a healthy running agent.
  This initial spawn-wedge is a **genuine one-off** — only **1 of ~110**
  agents has ever been stuck at `spawning`, and the precise trigger is not
  recoverable from the logs. We are **not** chasing it; a re-run clears it.

- The user clicked **Stop** (`POST /api/agents/[id]/stop` → `supervisor.kill()`).
  The journal shows, twice:

  ```
  [stop-agent] kill failed ExecaError: Command failed with exit code 1:
  tmux -L maw kill-session -t maw-agent-01KVCNC79TWD3AH7FG1TR659T6
  stderr: 'no current target'
  ```

### Root cause of the unrecoverability (the bug we fix)

1. `Tmux.killSession()` (`src/lib/server/tmux/TmuxSession.ts:284-293`) only
   swallows stderr matching `/can't find session|session not found|no server
   running/i`. tmux emits **`can't find session: X`** when other sessions
   exist, but emits **`no current target`** when the target can't be resolved
   **and the server has zero sessions left** (verified live:
   `tmux -L maw kill-session -t <missing>` returns `can't find session` while
   sessions exist). So when the agent's session already vanished and it was the
   last one, `killSession` **re-throws**.

2. `AgentSupervisor.kill()` (`AgentSupervisor.ts:954-989`) calls
   `await Tmux.killSession(row.tmux_session)` **unguarded** at line 975,
   **before** `updateAgentStatus(agentId,'exited')` at line 979. When
   killSession throws, the status flip, `runtime?.emit('state','exited')`,
   `fireTerminated`, config-dir cleanup, and commit snapshot never run → the
   agent stays at `spawning` forever and `/stop` returns HTTP 500.

There are **four scattered "session gone" regexes** (TmuxSession.ts lines 89,
219, 291, 393), each with a different subset of terms — the missing
`no current target` term in `killSession` is duplicated logic that drifted out
of sync. Repo CLAUDE.md emphasizes DRY, so we consolidate them.

### Intended outcome

Teardown becomes idempotent and resilient: a vanished tmux session is a no-op,
and a tmux failure can never strand an agent. The user can then Stop the
wedged dossier agent (200, not 500), clear it, and **re-run start-project** —
which, being a one-off, will start normally.

**Scope (user-confirmed):** kill-resiliency + tests only. **No** spawn
watchdog. **No** mutation of the live DB — the user will Stop/re-run and clear
records themselves after deploy.

---

## Implementation

### 0. Plan/branch hygiene (per global rules)
`git mv` this plan file to match the branch:
`docs/plans/fix-fail-dossier-start-project.md`.

### 1. Extract a shared `isSessionGoneError` helper — `src/lib/server/tmux/TmuxSession.ts`
Add an **exported** module-level helper after `shQuote` (~line 50):

```ts
/**
 * True when a tmux stderr means the target session / server is simply gone —
 * the safe-to-treat-as-success class for idempotent teardown and liveness
 * probes. Centralizes the variants tmux emits:
 *   "can't find session: <name>" · "can't find pane: <name>" ·
 *   "session not found" · "no current target" (last-session kill case) ·
 *   "no server running on …" · "no such file or directory" (socket absent)
 */
export function isSessionGoneError(stderr: string): boolean {
  return /can't find session|can't find pane|session not found|no current target|no server running|no such file or directory/i.test(
    stderr
  );
}
```
The new term is `no current target` (the bug). Every other term is carried
over so existing call sites keep identical coverage (`isPaneDead`'s bare
`can't find` is preserved via `can't find session|can't find pane`).

### 2. Use the helper in `killSession` (line 291) — the fix
```ts
const stderr = typeof e.stderr === 'string' ? e.stderr : '';
if (!isSessionGoneError(stderr)) throw err;  // session/server gone = no-op
```

### 3. DRY the other two throw/return sites (behavior-preserving supersets)
- `resizeWindow` (line 219): `if (!isSessionGoneError(stderr)) throw err;`
- `isPaneDead` (line 393): `if (isSessionGoneError(stderr)) return true;`
- **Leave `assertServerRunning` (line 89) as-is** — it only chooses info-hint
  vs. warn (never throws), and its "no server at boot" intent shouldn't be
  widened to `no current target`. Note this in the PR.

### 4. Make `AgentSupervisor.kill()` resilient — `AgentSupervisor.ts:975-988`
Guard the tmux teardown so the DB archive + observable events **always** run,
mirroring the unconditional status-flip ordering already used in
`finishAsExited` (456-534):

```ts
try {
  await Tmux.killSession(row.tmux_session);
} catch (err) {
  console.warn(`[AgentSupervisor] kill: tmux teardown failed for ${agentId} (archiving anyway):`, err);
}
if (row.cli_kind === 'claude-code') removeAgentClaudeConfigDir(agentId);
updateAgentStatus(agentId, 'exited');
runtime?.emit('state', 'exited');
this.fireTerminated(agentId, 'exited');
snapshotAgentCommits(agentId).then(/* unchanged */).catch(() => {});
```
For the wedged agent there is no `runtime` in the map (launch never reached
`this.runtimes.set`), so `runtime?.emit` is a safe no-op and the lines 955-960
guards already hold. `updateAgentStatus('exited')` is the load-bearing flip and
is now unconditional.

### 5. Routes — verify no change needed
- `stop/+server.ts` (33-38): after the fix, `kill()` no longer throws on the
  session-gone path → returns 200. Keep the try/catch→500 as a genuine-failure
  backstop. **No edit.**
- `[id]/+server.ts` delete route (80-85): already try/catches `kill()` and logs
  `[delete-agent] kill failed`; the resilience fix just stops that log firing
  for the session-gone case. **No edit.**

State explicitly in the PR that Changes 1-4 fix both Stop and Delete paths.

---

## Tests

Run: `pnpm test -- src/lib/server/tmux/TmuxSession.test.ts src/lib/server/agents/AgentSupervisor.kill.test.ts`
(both live under the `server` vitest project). Follow with `pnpm run check`
and `pnpm run lint`.

### A. `src/lib/server/tmux/TmuxSession.test.ts` (extend existing)
- `killSession` swallows `no current target` → resolves.
- Keep the existing "rethrows unrelated errors" case (`permission denied` must
  still throw) — proves the widened regex isn't a catch-all.
- `describe('isSessionGoneError')`: `it.each` over the gone-variants → `true`;
  `permission denied` / `unknown option` → `false`. Add `isSessionGoneError` to
  the import (line 9).
- One `it` each that `resizeWindow` / `isPaneDead` now tolerate
  `no current target`.

### B. New `src/lib/server/agents/AgentSupervisor.kill.test.ts`
Reuse the mock preamble from `AgentSupervisor.restart.test.ts` (in-memory DB +
TmuxSession/AgentRuntime/config/claudeConfigDir/commitSnapshot/etc. mocks). Add
a `seedSpawningAgent()` helper (adapt `seedCrashedAgent`: `status:'spawning'`,
no `insertAgentRun`). Cases:
- **Wedged spawning agent archives even when `killSession` rejects with
  `no current target`** → `getAgent('a1').status === 'exited'` and
  `fireTerminated` fired with `'exited'`. (The regression for this bug.)
- killSession rejects with a non-session-gone error (`permission denied`) →
  agent still flips to `exited` (proves Change 4's unconditional guard, per the
  user's "teardown failure must not prevent archival" requirement).
- Happy path: killSession resolves → `killSession` called with the session
  name, status `exited`.

---

## Verification (end-to-end)

1. `pnpm test -- …TmuxSession.test.ts …AgentSupervisor.kill.test.ts` green;
   `pnpm run check` + `pnpm run lint` clean.
2. Manual reproduction of the original error string (no install mutation):
   on an empty `-L maw` server, `tmux -L maw kill-session -t maw-agent-x`
   yields `no current target` — assert `isSessionGoneError` matches it.
3. After deploy, the user clicks **Stop** on the wedged dossier agent → 200,
   agent flips to `exited` (no `[stop-agent] kill failed` in the journal), then
   re-runs the start-project task, which starts normally.

## Out of scope / follow-ups (flagged, not done)
- Spawn watchdog for `spawning`-stuck agents (user declined for now).
- `kill()` vs `finishAsExited()` both "archive a CLI agent" with different
  ordering — a shared `archiveCliAgent()` extraction is tempting but a separate
  refactor; flag for later, don't expand this fix.
- Live DB cleanup of the stuck agent/worktree/queue entry — user will handle.
