# Supervisor AI Orchestration Layer

> After approval, `git mv` this file to `docs/plans/feat-task-supervisor.md`
> (match plan = branch = worktree name).

## Context

MAW already runs individual coding-agent CLIs in tmux/worktrees, with a
`queue_entries` backlog, a `QueueScheduler` that promotes tasks to agents, an
`AgentSupervisor` that reattaches across reboots, Claude Code hooks that emit
events, and an alert + Web Push pipeline. What's missing is an **orchestration
layer** that takes a large product plan and drives it end-to-end: split it into
tasks, get human approval, execute each task, run an automated quality check,
loop fixes back to the agent, and push finished branches for the human to PR —
all while surviving reboots and being cleanly stoppable.

This plan adds that layer as a **deterministic backend service** (a state
machine, structurally like `QueueScheduler`) that makes **bounded LLM calls only
for two reasoning steps** — splitting the plan and producing a quality-check
verdict. The real coding and QC work is still done by ordinary CLI agents in
tmux. This keeps stop/reboot reliable, cost countable, and the control flow
testable, while reusing the machinery that already works.

### Decisions (confirmed with user)

1. **Core** = deterministic service + 2 bounded LLM calls (plan-split, QC verdict). Not an LLM-agent-in-tmux.
2. **Git policy** = supervisor commits + pushes the task branch, then alerts the human to open a PR into `development`. **It never merges.**
3. **Autonomy** = task agents spawn in **`bypassPermissions`** ("full auto"). The loop runs unattended; the human is pinged only on agent questions, errors, stalls, crashes, and QC results.
4. **Execution** = **sequential**, one approved task at a time.

### Consequence of full-auto on "notify human on problem" (user's step 5)

With `bypassPermissions` there are **no permission prompts to forward**. So the
human-attention signal shifts to a **watchdog** over four conditions:
- agent **idle with an unanswered question** (Claude `Notification`/idle hook still fires),
- **error** adapter events,
- **stall** (no output / no `task_done` within a per-step wall-clock timeout — new),
- **crash** (`onAgentTerminated` with terminal status).
Any of these → `step.phase = blocked_on_human` + existing alert/push.

---

## Architecture overview

```
SupervisorEngine (singleton, like QueueScheduler)
  planning ──LLM split──▶ awaiting_approval ──human approve──▶ executing
     per step:
        running_task ──task_done + commit verified──▶ awaiting_commit
        awaiting_commit ──enqueue QC task──▶ quality_check
        quality_check ──LLM verdict──▶  fail & under cap ─▶ fixing ↺ running_task
                                        pass            ─▶ ready_to_push ─▶ pushed ─▶ done
        (any active phase) ──watchdog trip──▶ blocked_on_human ──human──▶ resume
     all steps done ─▶ run done
```

The engine is a **consumer of the existing queue**: it inserts `queue_entries`
and reacts to their status changes + `task_done`/termination signals. It does
**not** re-implement promotion, spawning, or killing — those stay in
`QueueScheduler` / `AgentSupervisor`.

---

## Stage 1 — Data layer

**New migration `migrations/015_supervisor.sql`** (next number after 014). Four
tables; reuse `queue_entries` and the currently-unused `llm_oversight_verdicts`.

- **`supervisor_runs`** — one per product plan.
  `id, user_id, repo_id, role_id (coding role), qc_role_id (QC role), title,
  plan_md, phase, stop_mode (NULL|normal|emergency), current_step_id,
  config_json (frozen run config: fix cap, autonomy, exec mode, budget),
  error, created_at, updated_at, started_at, completed_at`.
- **`supervisor_steps`** — one per generated sub-task (the unit humans approve).
  `id, run_id, user_id, seq, title, body, depends_on_json, phase,
  queue_entry_id, qc_queue_entry_id, agent_id, fix_iterations,
  last_verdict_id, approval_state (pending|approved|sent_back),
  refinement_notes, base_sha, branch, created/updated_at`.
- **`supervisor_run_events`** — append-only checkpoint/audit log powering the
  timeline UI and reboot diagnosis. `id, run_id, step_id, kind, payload_json, ts`.
- **`project_memory`** — repo-scoped recurring-issues store (Stage 8).
  `id, user_id, repo_id, category, lesson, detail, hit_count, last_seen_at,
  source_run_id, active, created/updated_at`.

**Reuse `queue_entries`** for actual execution: set `with_worktree=1`,
`permission_mode='bypassPermissions'`, `queued=1`, `depends_on_json` (sequential
chain), and an `external_source_json`-style marker
`{supervisor_run_id, step_id, kind:'task'|'qc'|'fix'}` so reconciliation can find
the owning step without the scheduler needing to know about the supervisor.

**Reuse `llm_oversight_verdicts`** for QC verdicts: `verdict='pass'|'fail'`,
`rationale` = JSON `{issues:[{category,severity,detail}]}`, `agent_id` = QC agent,
token counts. One row per QC iteration.

**Files:** `migrations/015_supervisor.sql`; add row + enum types to
`src/lib/server/db/types.ts` (`SupervisorRunRow`, `SupervisorStepRow`,
`SupervisorRunEventRow`, `ProjectMemoryRow`, `SupervisorRunPhase`,
`SupervisorStepPhase`); add prepared queries to `src/lib/server/db/queries.ts`
(CRUD for the 4 tables, verdict insert/get, typed getters for `supervisor.*`
settings mirroring the existing `getQueueConcurrency` pattern).

## Stage 2 — Bounded LLM client

New `src/lib/server/supervisor/llm.ts`: a `fetch`-based Anthropic Messages call
using `config.anthropicApiKey` (already in `config.ts`), forcing **tool-use
structured output**, validated with **zod** (already a dependency). Two schemas:
`PlanSplitResult` (`tasks: [{title, body, depends_on?}]`) and `QcVerdict`
(`{verdict, issues:[{category,severity,detail}]}`). Model from `supervisor.model`
setting. Records token usage onto the relevant rows. Keep it dependency-light
(no new SDK), matching the rest of the server. Unit-test with mocked `fetch`.

## Stage 3 — Engine core

New `src/lib/server/supervisor/SupervisorEngine.ts` — singleton like
`src/lib/server/queue/Scheduler.ts`:
- subscribes to `queueScheduler.events.on('change')` and to agent
  `task_done`/termination signals from `AgentSupervisor`;
- owns the run-level and step-level state machines (phases above);
- **writes the new phase + a `supervisor_run_events` checkpoint BEFORE side
  effects** (same discipline as the scheduler writing status before spawning);
- enqueues coding / QC / fix `queue_entries`; never spawns or kills directly;
- enforces the **fix-loop cap** (`supervisor.fix_loop_cap`, default 3) and an
  optional per-run **token budget** → on exceed: `blocked_on_human` + `critical` alert.

**Task-done detection (reliable, two-tier):** primary signal is the coding
task's `queue_entries` row flipping to `done` (the agent process exited, via the
existing path). Because "exited" ≠ "committed", the engine then **verifies the
commit** (head SHA advanced from `base_sha`, working tree clean) via a new
read-only helper in `WorktreeManager` before advancing. For Claude Code we also
add a `Stop` hook (Stage 4) for a crisp "turn finished" event; non-Claude CLIs
fall back to termination + commit verification (documented asymmetry).

**QC step:** enqueue a QC `queue_entries` using `qc_role_id` on the step's branch
with the step's base→head diff scoped in the prompt. After the QC agent finishes,
the engine makes the **bounded verdict LLM call** (diff + QC transcript →
structured `QcVerdict`) so branching is deterministic regardless of how the QC
agent phrased things. Persist to `llm_oversight_verdicts`; set
`step.last_verdict_id`.

**Branch on verdict:** `fail` & under cap → create a **fix** `queue_entries`
(body = the issues), `fix_iterations++`, back to `running_task`. `pass` → verify
commit, **push branch** (new `WorktreeManager.pushBranch`, honoring
`git.identity`), `ready_to_push → pushed → done`, raise an `info` alert "Step X
ready for PR" with a deep link. Then pick the next approved `pending` step
(sequential). All steps done → run `done`.

New `src/lib/server/supervisor/projectMemory.ts` — cluster + inject (Stage 8).

## Stage 4 — Completion signal & git helpers

- Extend `src/lib/server/agents/claudeHooks.ts` to also register the **`Stop`
  hook** (POST to `/api/internal/claude-hook`); extend
  `src/lib/server/agents/AgentRuntime.ts` `ingestHookEvent()` to map `Stop` → a
  `task_done`-class adapter event; adjust `/api/internal/claude-hook` if needed.
- Add to `src/lib/server/git/WorktreeManager.ts`: a read-only
  `verifyCommit(baseSha, worktreePath)` (head advanced + clean tree) and
  `pushBranch(branch)`.

## Stage 5 — Bootstrap + reboot reconciliation

Add `SupervisorEngine.init()` and wire it into `src/lib/server/bootstrap.ts`
**after** `QueueScheduler.start` (new step 6b). Reconciliation mirrors
`reconcileOrphanedRunning()`: for every non-terminal run, **honor `stop_mode`
first**, then per step phase re-derive position from the (already-reconciled)
`queue_entries` status + git state:
- `running_task`/`fixing`: queue entry `done` → `awaiting_commit`; `failed` →
  one auto-retry then `blocked_on_human`.
- `awaiting_commit`: re-verify commit; proceed or re-issue.
- `quality_check`: QC entry `done` but no verdict row → re-run verdict call
  (idempotent); verdict exists → branch.
- `ready_to_push`/`pushed`: idempotent re-push.
- `blocked_on_human`: leave; the alert row re-surfaces in the UI.
Live tmux agents are reattached by the existing `AgentSupervisor.init()`; the
engine only restores the **orchestration position**.

## Stage 6 — API + WebSocket

New routes under `src/routes/api/supervisor/` (CSRF via existing `apiFetch`/
`verifyCsrf`): create run, get/list, approve/send-back a step (send-back writes
`refinement_notes`, sets `sent_back`, triggers a scoped re-split call),
edit/reorder steps, **normal-stop**, **emergency-stop**. Extend
`src/lib/shared/protocol.ts` + `src/lib/server/ws/hub.ts` with supervisor
run/step live events so the UI updates in real time.

**Stop semantics (persisted on `supervisor_runs.stop_mode`):**
- *normal:* `phase=stopping`; stop enqueuing new steps, let in-flight steps
  finish to `done`/`ready_to_push`; when none active → `stopped`.
- *emergency:* cancel this run's open `queue_entries` via
  `queueScheduler.cancelEntry()` (which already kills linked agents →
  `Tmux.killSession`), mark non-terminal steps `failed`, run → `stopped`.
Both are checkpointed, so a reboot resumes/completes the stop.

## Stage 7 — Frontend

- `/supervisor` index (list runs, create-run entry: paste plan / pick repo +
  coding role + QC role).
- `/supervisor/[runId]`: generated step list with **edit / reorder / merge /
  split**, per-step **Approve** / **Send back with changes**, "Approve all &
  run", a live execution **timeline** (from `supervisor_run_events`), and
  **Normal stop / Emergency stop** buttons.
- **Supervisor** section on `/settings` for the `supervisor.*` settings.
- Small **project-memory** panel on `/repos/[id]` to view/retire lessons.
Reuse `Modal.svelte`, `ConfirmDialog.svelte` (destructive tone for emergency
stop), and the spawn/role patterns. Do **not** edit vendored
`src/lib/components/ui/`.

## Stage 8 — Project memory (recurring issues)

Deterministic bookkeeping (no LLM): after each QC verdict, cluster `issues[]` by
`category`; for the repo, increment `hit_count`/`last_seen_at` on an existing
lesson or insert a new one; promote to a confirmed "lesson" past a threshold
(seen in ≥2 steps/runs) or on high severity. **Injection:** at enqueue time,
fetch `active` lessons for the repo and append a "Known recurring issues in this
repo — avoid these" block to the task/fix/QC `queue_entries.body` (no new
delivery mechanism — `performSpawn` already materializes the body into the
agent's prompt). User can retire lessons (`active=0`) from the repo panel.

## Configuration surface (new `user_settings` keys)

`supervisor.planner_prompt`, `supervisor.fix_loop_cap` (3),
`supervisor.execution_mode` (`sequential`), `supervisor.autonomy`
(`bypassPermissions` per decision; kept as a setting for future flexibility),
`supervisor.model`, `supervisor.token_budget` (optional), `supervisor.stall_timeout`.
The **QC prompt lives on a dedicated QC `role`** (its `system_prompt`), selected
per-run as `qc_role_id` — reuses the existing roles editor wholesale. Per-run
overrides are frozen into `supervisor_runs.config_json` at start.

---

## Open risks / resolutions

- **Step 7 vs 8 wording** ("pull into development" vs "let user PR"): resolved —
  supervisor **only commits + pushes + alerts**; the human PRs/merges. "Continue
  with next task" proceeds independently of the human's review.
- **Infinite oscillation** (pass↔fail across reruns): fix-loop cap + optional
  per-run token budget → hard stop + alert.
- **Stall / stuck agent** (no prompt to forward in full-auto): per-step
  wall-clock `stall_timeout` watchdog → `blocked_on_human`. The existing reaper
  only catches dead tmux, not live-but-stuck.
- **Crashed task agent:** one auto-retry, then block on human.
- **Auto-commit safety:** verify `git status`/diff before QC; commit the step's
  changes deliberately rather than blanket `add -A` where feasible.
- **QC reading the right diff:** pass `base_sha` (from `agents.base_sha`) so QC
  inspects only the step's changes.
- **CLI asymmetry:** `Stop`-hook completion signal is Claude-only; others use
  termination + commit verification.

## Testing strategy

- **Unit (Vitest server, `vi.mock` queries/auth):** every state-machine edge
  (`running_task→awaiting_commit→quality_check→fixing↺` and `→ready_to_push`);
  fix-loop cap; sequential next-step selection; QC `QcVerdict` zod parse
  accept/reject; normal vs emergency stop (assert `cancelEntry` per entry);
  project-memory clustering/threshold; reconciliation resume per phase.
- **Integration:** `SupervisorEngine` on in-memory SQLite with mocked
  `AgentSupervisor`/`QueueScheduler` and stubbed LLM calls — drive a full run
  planning→done; assert rows in `queue_entries`, `supervisor_steps`,
  `llm_oversight_verdicts`, `project_memory`.
- **E2E (Playwright):** create run from pasted plan → see steps → edit/reorder →
  approve → observe WS execution updates → trigger normal + emergency stop.

## Verification (end-to-end)

1. `pnpm test` (server + client unit) and the new integration suite pass.
2. Apply migration on a scratch DB; confirm tables + reboot reconciliation by
   killing/restarting the backend mid-run and observing the run resume at its
   checkpointed phase.
3. Manual: paste a small 2–3 task plan against a throwaway repo, approve, watch
   tasks execute in `bypassPermissions`, force a QC `fail` (e.g. introduce a DRY
   violation) to confirm the fix loop, then a `pass` to confirm push + "ready for
   PR" alert + Web Push. Confirm a recurring issue lands in `project_memory` and
   is injected into the next task's prompt.
4. Trigger normal stop (current task finishes, loop halts) and emergency stop
   (tmux sessions killed immediately, run marked stopped).

## Critical files

- New: `migrations/015_supervisor.sql`,
  `src/lib/server/supervisor/{SupervisorEngine,llm,projectMemory}.ts`,
  `src/routes/api/supervisor/**`, `src/routes/supervisor/**`.
- Modify: `src/lib/server/db/{types,queries}.ts`,
  `src/lib/server/bootstrap.ts`,
  `src/lib/server/agents/{claudeHooks,AgentRuntime}.ts`,
  `src/lib/server/git/WorktreeManager.ts`,
  `src/lib/shared/protocol.ts`, `src/lib/server/ws/hub.ts`,
  `src/routes/settings/**`, `src/routes/repos/[id]/**`.
- Reuse (unchanged): `src/lib/server/queue/Scheduler.ts`,
  `src/lib/server/agents/{AgentSupervisor,spawnFromInputs}.ts`,
  `src/lib/server/push/PushService.ts`.
