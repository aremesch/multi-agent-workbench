# feat: restart/continue crashed agents from the archive + show agent definition

## Context

Agents run inside tmux sessions. When the host crashes or reboots while an
agent is working, its tmux session dies; on the next boot `AgentSupervisor.init()`
finds the session gone and marks the agent `crashed`. Today a crashed agent is
a dead end — the user can only view its log/plan or delete it. The in-progress
work (the git worktree, and for Claude Code the full conversation transcript)
is still on disk, so it should be possible to pick the work back up.

This change adds two things to the **Archive view** (`/repos/[id]/archive`):

1. A kebab-menu action **"Restart/continue work"** for `crashed` agents that
   revives the same agent in place — reusing its worktree, branch, and (for
   Claude Code) its conversation transcript via `claude --resume`.
2. A kebab-menu action **"Show Definition"** that surfaces the original agent
   definition — role system prompt, the task prompt/body, model, permission
   mode, CLI kind, and source branch — none of which the archive currently
   shows.

### Decisions (confirmed with the user)

- **Smart resume.** For `claude-code` agents whose transcript survived the
  crash, relaunch with `claude --resume <session-id>` so the agent keeps full
  prior context. Otherwise fall back to a fresh re-spawn that re-feeds the
  original task body. Non-Claude CLIs always take the fresh path.
- **Crashed only.** The restart action is offered only for `status='crashed'`.
- **Revive in place**, reusing the same agent row (so token/commit history and
  the `cli_session_id` needed for `--resume` stay linked) — **but only after
  verifying the worktree directory and source branch still exist.**

### Why resume works only for crashed (not cleanly-exited) agents

Claude Code's transcript lives under the agent's isolated `CLAUDE_CONFIG_DIR`
(`<dataDir>/agents/<id>/claude/projects/<encoded-cwd>/<uuid>.jsonl`). A clean
exit/kill deletes that dir (`removeAgentClaudeConfigDir` in `finishAsExited`/
`kill`). A crash is detected in `init()` and marks the row `crashed` **without**
that cleanup, so the transcript survives. `ensureAgentClaudeConfigDir` only
re-seeds `.claude.json`/`CLAUDE.md`/`settings.json` and re-symlinks
`plugins`/`plans` — it never touches `projects/`, so re-running it on restart
is safe for the transcript.

---

## Implementation

### 1. Adapter: a `resume` spawn variant (config-driven)

`claude --resume <uuid>` (same uuid passed to `--session-id` at first spawn)
restores the conversation and accepts an extra positional prompt. Make this a
config concern, not supervisor special-casing.

- **`cli-adapters/claude-code.jsonc`** — add an optional `spawn.resume` block:
  ```jsonc
  "resume": {
    "args": ["--resume", "{{agent.cliSessionId}}"],
    "initialInput": { "delivery": "cli-arg", "template": "{{task.body}}",
                      "placement": "positional-last", "omitWhenEmpty": true }
  }
  ```
- **`schemas/adapter.schema.json`** + **`src/lib/server/agents/adapters/adapter.config.schema.ts`**
  — add the optional `resume` shape under `spawn` (mirrors `args` +
  `initialInput`).
- **`src/lib/shared/adapterTypes.ts`** — add `mode?: 'spawn' | 'resume'` to
  `BuildSpawnSpecOpts` (default `'spawn'`); add a derived `supportsResume:
  boolean` to the adapter interface.
- **`src/lib/server/agents/adapters/ConfigDrivenAdapter.ts`** — when
  `mode==='resume' && cfg.spawn.resume`, use `cfg.spawn.resume.args` as the base
  args and `cfg.spawn.resume.initialInput ?? cfg.spawn.initialInput` for the
  positional prompt. **Keep** appending capability args (`--model`,
  `--permission-mode`) and `optionalArgs` (Claude accepts them on `--resume`).
  Set `supportsResume = !!cfg.spawn.resume`. Default mode leaves all existing
  callers byte-for-byte unchanged (regression guard in tests).

### 2. Worktree/branch validation helper

**`src/lib/server/git/WorktreeManager.ts`** — add:
```ts
static async validateForReuse(opts: {
  worktree: WorktreeRow | undefined; repoPath: string;
  sourceBranch: string | null; agentId: string; worktreeRoot: string;
}): Promise<{ ok: true; recreated: boolean; path: string }
          | { ok: false; code: 'worktree_gone' | 'branch_gone' }>
```
Logic (pragmatic, hot path is one `existsSync`):
1. row missing or `status==='removed'` → `worktree_gone`.
2. `existsSync(worktree.path)` → happy path `{ok:true, recreated:false}`.
3. dir missing: if `sourceBranch` exists in `listBranches(repoPath)` →
   **recreate** via `create({ ..., branch: sourceBranch, startPoint:
   sourceBranch, dirName: basename(worktree.path) })` (the `-B` re-points the
   branch to itself, materializing the worktree; the branch tip with prior
   commits is preserved) → `{ok:true, recreated:true}`. Else → `branch_gone`.

**`base_sha` is never overwritten on recreation** — keep the original so
`snapshotAgentCommits` (keyed on `committer_email` + base) keeps attributing the
prior commit range.

### 3. Supervisor: extract `launchCliRuntime`, add `restart`

**`src/lib/server/agents/AgentSupervisor.ts`**

DRY refactor — extract the shared CLI-launch tail of `spawn()` (everything from
`writeClaudeHookSettings` through `insertAgentRun` + `updateAgentStatus('running')`,
incl. env assembly with `CLAUDE_CONFIG_DIR`, `Tmux.newSession`, `new
AgentRuntime`, `wireAlertBus`, `runtime.start()` with rollback, `runtimes.set`,
`startExitWatcher`) into:
```ts
private async launchCliRuntime(args: {
  row: AgentRow; adapter: CliAdapter; spec: SpawnSpec; hookToken: string | null;
  worktreePath: string; committerName: string; committerEmail: string;
  authorIdentity: { name: string; email: string };
  onStartFailure: () => void;   // spawn → deleteAgent; restart → flip to 'crashed'
}): Promise<AgentRow>
```
The only behavioral change to `spawn()`: the `runtime.start()` rollback calls the
injected `onStartFailure` (spawn passes `() => deleteAgent(agentId)`), preserving
the existing worktree-rollback chain in `performSpawn`.

Add:
```ts
async restart(agentId: string): Promise<
  | { ok: true; mode: 'resume' | 'fresh'; row: AgentRow }
  | { ok: false; code: 'not_crashed' | 'worktree_gone' | 'branch_gone'
      | 'unknown_kind' | 'browser_unsupported' | 'launch_failed'; message?: string }>
```
Body: load agent → guard `status==='crashed'`; reject `isBrowserKind`
(`browser_unsupported`) and `!registry.has(cli_kind)` (`unknown_kind`).
Defensive `stopExitWatcher(agentId)` + `runtimes.delete(agentId)`. Run
`validateForReuse`; on failure return its code. Resolve role + linked task
(`getTask(row.current_task_id)`). Decide mode:
```ts
const transcript = jsonlPathInRoot(agentClaudeConfigDir(agentId), worktreePath, row.cli_session_id ?? '');
const mode = (adapter.supportsResume && row.cli_kind === 'claude-code'
             && row.cli_session_id && existsSync(transcript)) ? 'resume' : 'fresh';
```
Build spec via `buildSpawnSpec({ ..., mode, task, capabilityValues: { model:
row.model, permissionMode: row.permission_mode }, agent: { id, cliSessionId:
row.cli_session_id } })`. Flip `updateAgentStatus(agentId,'spawning')`, then call
`launchCliRuntime({ row, ..., onStartFailure: () => updateAgentStatus(agentId,'crashed') })`
(reuses `row.tmux_session`, `row.hook_token`). Returns the new run automatically
(launchCliRuntime does `insertAgentRun` + status→running). **No new agent row.**

### 4. API endpoint

**`src/routes/api/agents/[id]/restart/+server.ts`** (new) — mirror the DELETE
route style (`verifyCsrf`, 401/404/403, status guard). `POST` calls
`locals.supervisor.restart(id)`. Success → `200 {ok:true, mode, agentId}`.
Failures → `409 {code}` (`not_crashed`/`worktree_gone`/`branch_gone`/…) or
`500 {code:'launch_failed', message}` (row is left at `crashed` so retry works).

### 5. "Show Definition" data in the archive loader

**`src/routes/repos/[id]/archive/+page.server.ts`** — in the per-agent map,
add `getRole(a.role_id)` and `a.current_task_id ? getTask(...) : null` (both
cheap indexed lookups). Extend `ArchivedAgentEntry` with:
```ts
restartable: boolean;   // a.status==='crashed' && !isBrowserKind && wt?.status!=='removed' && existsSync(wt.path)
definition: { roleName; systemPrompt; taskTitle; taskBody; model;
              permissionMode; cliKind; sourceBranch };
```
`wt = getWorktree(a.worktree_id)` is already fetched for the token summary —
reuse it; `restartable` adds only an `existsSync`. (The endpoint re-validates,
so this flag is purely a UX disable, not a gate.)

### 6. Frontend wiring

- **`src/lib/client/components/AgentMenu.svelte`** — add optional props
  `onRestart?`, `onShowDefinition?`, `restartable = false`. Add a
  `restart` item (`dividerBefore`, disabled unless `status==='crashed' &&
  restartable`, only rendered when `onRestart` is passed) and an always-enabled
  `definition` item. Add i18n keys `agentMenu.restart`, `agentMenu.showDefinition`.
- **`src/lib/client/components/AgentDefinitionModal.svelte`** (new) — consistent
  with `PlanViewerModal`/`ArchivedAgentLogModal`; read-only sections for the
  `definition` object (system prompt + task body in scrollable `<pre>`, plus
  model/permission/CLI/branch). No fetch — data comes from the loader.
- **`src/routes/repos/[id]/archive/+page.svelte`** — wire `restartable`,
  `onShowDefinition`, `onRestart` into `<AgentMenu>`. Add a small restart
  state machine (`idle|working|error`) mirroring the existing delete one,
  using `apiFetch('/api/agents/:id/restart', {method:'POST'})`. On success
  `goto('/repos/<repoId>?agent=<id>')` (the agent is now live and has left the
  archive); on a 409 show the error and `invalidateAll()` to refresh the
  now-stale `restartable` flags.

---

## Risks (carry into implementation)

- **`ensureAgentClaudeConfigDir` on resume** — safe for the transcript (never
  touches `projects/`); it does overwrite the agent-local `.claude.json` with
  the current user-global copy (acceptable: "latest creds" semantic).
- **tmux session-name reuse** — reusing `row.tmux_session` is fine (old session
  is dead). The defensive `stopExitWatcher`/`runtimes.delete` at the top of
  `restart` guards against any stale in-memory entry.
- **`restart` returns a result object; `spawn` throws** — intentional: restart
  is recoverable (keep the `crashed` row on launch failure) vs spawn's full
  rollback. Reconciled via the injected `onStartFailure`.
- **Token-summary path mismatch** — the loader reads tokens via `jsonlPathFor`
  (legacy `~/.claude` path), while the resume check uses `jsonlPathInRoot`
  (isolated dir). Resume eligibility keys on the isolated path where crashed
  agents actually wrote; the loader's existing behavior is unchanged. If a
  transcript is found in neither, mode degrades to `fresh` — correct.
- **Optional-arg picks not persisted** on the agent row → restart uses adapter
  defaults (claude-code ships none, so no impact); the definition modal cannot
  show original optional-arg toggles.

---

## Tests (vitest)

- **`ConfigDrivenAdapter`** (extend existing test): `buildSpawnSpec({mode:'resume'})`
  emits `--resume <uuid>` not `--session-id`; default mode unchanged; capability
  args still appended; `supportsResume` reflects the `resume` block.
- **`WorktreeManager.validateForReuse`** (real git temp repo): dir-exists →
  `recreated:false`; removed row → `worktree_gone`; dir-missing+branch-exists →
  recreates, dir back on disk, branch tip unchanged; dir+branch missing →
  `branch_gone`.
- **`AgentSupervisor.restart`** (new test, mock `Tmux`/`AgentRuntime` per the
  existing lifecycle-test harness): same agent id, status→running, exactly one
  new `agent_runs` row, no new agent row; resume-vs-fresh decision toggles on a
  transcript file's presence; `worktree_gone` leaves status `crashed` with no
  run; `not_crashed` for an `exited` agent; launch failure flips back to
  `crashed` and does **not** delete the row.
- **Archive loader shape**: `definition.systemPrompt` from role,
  `definition.taskBody` from linked task; `restartable` false for `exited`,
  true for `crashed` with a live worktree.

## Verification (manual, end-to-end)

1. Spawn a `claude-code` agent with a task; let it do some work.
2. Kill its tmux session out-of-band (`tmux -L maw kill-session -t <name>`) and
   restart MAW so `init()` marks it `crashed`.
3. Open `/repos/[id]/archive`, open the kebab → **Show Definition** shows the
   role prompt + original task body. **Restart/continue work** is enabled.
4. Click Restart → redirected to the live repo view; the agent is `running` and
   (resume path) the terminal shows the restored conversation. Confirm a new
   `agent_runs` row and the same agent id.
5. Negative: delete the worktree dir on disk, reload archive → Restart disabled;
   force the call via API → `409 worktree_gone`.
