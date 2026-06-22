-- Multi-Agent Workbench — Supervisor AI orchestration layer (v0.5).
--
-- See docs/plans/feat-task-supervisor.md.
--
-- The supervisor is a deterministic backend state machine (like the
-- QueueScheduler) that drives a large product plan end-to-end: split it into
-- steps, get human approval, execute each step as a queue_entries agent, run a
-- quality-check agent, loop fixes back, and push finished branches for the
-- human to PR. It makes bounded LLM calls only for plan-splitting and the QC
-- verdict; the real coding/QC work is done by ordinary CLI agents in tmux.
--
-- supervisor_runs:  one row per product plan. `phase` is the run-level state
--                   machine. `stop_mode` records a requested normal/emergency
--                   stop and is honored on every transition + on reboot.
--                   `config_json` freezes the run's config (fix-loop cap,
--                   autonomy, execution mode, token budget) at start so a later
--                   settings edit can't change a running run's semantics.
--
-- supervisor_steps: one row per generated sub-task (the unit the human
--                   approves). The supervisor's own ledger; it POINTS AT the
--                   queue_entries row that actually executes the work rather
--                   than duplicating it. `phase` is the per-step state machine:
--                     pending → running_task → awaiting_commit → quality_check
--                       → fixing ↺ running_task   (QC fail, under cap)
--                       → ready_to_push → pushed → done   (QC pass)
--                     blocked_on_human is orthogonal (watchdog trip / cap hit /
--                     crash); it remembers nothing extra beyond blocked_reason.
--
-- supervisor_run_events: append-only checkpoint / audit log powering the
--                   run-detail timeline and post-reboot diagnosis.
--
-- project_memory:   repo-scoped "lessons learned" — recurring issue classes the
--                   QC step keeps flagging. One row per (repo, category);
--                   hit_count increments on repeat. Active lessons are injected
--                   into new task / QC agent prompts so the same mistakes stop
--                   recurring across steps and runs.

CREATE TABLE supervisor_runs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE RESTRICT,
  role_id         TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  qc_role_id      TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  title           TEXT NOT NULL,
  plan_md         TEXT NOT NULL DEFAULT '',
  phase           TEXT NOT NULL CHECK (phase IN
                    ('planning','awaiting_approval','executing','stopping',
                     'done','stopped','failed')),
  stop_mode       TEXT CHECK (stop_mode IN ('normal','emergency')),
  current_step_id TEXT,
  config_json     TEXT NOT NULL DEFAULT '{}',
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER
);

CREATE INDEX idx_supervisor_runs_user_phase ON supervisor_runs(user_id, phase);

CREATE TABLE supervisor_steps (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES supervisor_runs(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  depends_on_json   TEXT NOT NULL DEFAULT '[]',   -- array of supervisor_steps.id
  phase             TEXT NOT NULL CHECK (phase IN
                      ('pending','running_task','awaiting_commit','quality_check',
                       'fixing','ready_to_push','pushed','done',
                       'blocked_on_human','failed')),
  approval_state    TEXT NOT NULL DEFAULT 'pending' CHECK (approval_state IN
                      ('pending','approved','sent_back')),
  refinement_notes  TEXT,
  queue_entry_id    TEXT REFERENCES queue_entries(id) ON DELETE SET NULL,
  qc_queue_entry_id TEXT REFERENCES queue_entries(id) ON DELETE SET NULL,
  agent_id          TEXT REFERENCES agents(id) ON DELETE SET NULL,
  fix_iterations    INTEGER NOT NULL DEFAULT 0,
  last_verdict_id   TEXT REFERENCES llm_oversight_verdicts(id) ON DELETE SET NULL,
  base_sha          TEXT,
  branch            TEXT,
  blocked_reason    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_supervisor_steps_run         ON supervisor_steps(run_id, seq);
CREATE INDEX idx_supervisor_steps_queue_entry ON supervisor_steps(queue_entry_id);
CREATE INDEX idx_supervisor_steps_qc_entry    ON supervisor_steps(qc_queue_entry_id);

CREATE TABLE supervisor_run_events (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES supervisor_runs(id) ON DELETE CASCADE,
  step_id      TEXT REFERENCES supervisor_steps(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           INTEGER NOT NULL
);

CREATE INDEX idx_supervisor_run_events_run ON supervisor_run_events(run_id, ts);

CREATE TABLE project_memory (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id       TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  lesson        TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  hit_count     INTEGER NOT NULL DEFAULT 1,
  last_seen_at  INTEGER NOT NULL,
  source_run_id TEXT REFERENCES supervisor_runs(id) ON DELETE SET NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_project_memory_repo_active ON project_memory(repo_id, active);
-- One lesson per (repo, category): repeat hits upsert-increment hit_count.
CREATE UNIQUE INDEX idx_project_memory_repo_category ON project_memory(repo_id, category);
