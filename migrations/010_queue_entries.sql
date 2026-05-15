-- Multi-Agent Workbench — Queue + Scheduler (v0.3).
--
-- See docs/plans/v0.2-v0-3-queue-scheduler.md.
--
-- queue_entries are pre-spawn agent specifications: every field the spawn
-- form collects (role + repo + title + body / target_url + branch +
-- worktree flag + model + permission_mode + optional args), plus
-- queue-specific metadata (priority, dependencies, scheduled-for,
-- exclusive). A scheduler tick reads queue_entries, picks one (subject to
-- slot caps and dependencies), and promotes it by calling
-- supervisor.spawn(); the spawned agent id is written back to
-- queue_entries.agent_id so the UI can link the queue row to the live
-- agent and so finishAsExited can find the entry on agent termination.
--
-- Status enum:
--   pending    newly created, not yet evaluated
--   blocked    unresolved deps OR scheduled_for > now OR transient validation
--   ready      eligible, waiting on a slot
--   running    promoted; agent_id set, agent live
--   done       linked agent exited with status='exited' (normal termination)
--   failed     linked agent crashed OR permanent pre-spawn validation hard-fail
--   cancelled  user cancelled; if was running, supervisor killed the agent

CREATE TABLE queue_entries (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id               TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  repo_id               TEXT NOT NULL REFERENCES repos(id) ON DELETE RESTRICT,

  -- Mirrors of the spawn form fields. Capability-driven columns are nullable
  -- and only filled when the chosen adapter exposes that capability — same
  -- contract as agents.model / agents.permission_mode / agents.source_branch.
  title                 TEXT NOT NULL,
  body                  TEXT,                                      -- NULL when adapter initialInputDelivery='none'
  target_url            TEXT,                                      -- browser-kind adapters only
  model                 TEXT,                                      -- only when capabilities.model exists
  permission_mode       TEXT,                                      -- only when capabilities.permissionMode exists
  source_branch         TEXT,                                      -- resolved against repo branches at save time
  with_worktree         INTEGER NOT NULL DEFAULT 1 CHECK (with_worktree IN (0,1)),
  optional_args_json    TEXT NOT NULL DEFAULT '{}',

  -- Queue-specific.
  priority              INTEGER NOT NULL DEFAULT 0,
  depends_on_json       TEXT NOT NULL DEFAULT '[]',
  scheduled_for         INTEGER,                                   -- unix epoch seconds; NULL = ASAP
  exclusive             INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0,1)),

  status                TEXT NOT NULL CHECK (status IN ('pending','blocked','ready','running','done','failed','cancelled')),
  agent_id              TEXT REFERENCES agents(id) ON DELETE SET NULL,
  external_source_json  TEXT,                                      -- populated by Stage 2 tracker bridge
  last_error            TEXT,

  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  started_at            INTEGER,
  completed_at          INTEGER
);

CREATE INDEX idx_queue_entries_user_status     ON queue_entries(user_id, status);
CREATE INDEX idx_queue_entries_user_scheduled  ON queue_entries(user_id, scheduled_for);
CREATE INDEX idx_queue_entries_repo_status     ON queue_entries(repo_id, status);
CREATE INDEX idx_queue_entries_agent           ON queue_entries(agent_id);
