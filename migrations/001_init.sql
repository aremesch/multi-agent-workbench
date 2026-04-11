-- Multi-Agent Workbench — initial schema (v0.1)
--
-- Conventions (see plan §Data model):
--   * every row has id TEXT PRIMARY KEY (ULID)
--   * created_at / updated_at are Unix epoch seconds (INTEGER NOT NULL)
--   * every domain row carries user_id TEXT NOT NULL for forward-compat multi-user
--   * JSON blobs are stored as TEXT and parsed in TS, never via sqlite json1
--
-- Migration tracking is handled by src/lib/server/db/migrate.ts using the
-- __drizzle_migrations table (Drizzle-compatible format) — not touched here.

-- ---------- users / sessions ----------

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ---------- projects / repos / worktrees ----------

CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_projects_user ON projects(user_id);

CREATE TABLE repos (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  origin_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_repos_project ON repos(project_id);

CREATE TABLE worktrees (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id    TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  branch     TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('active','orphaned','removed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_worktrees_repo ON worktrees(repo_id);
CREATE INDEX idx_worktrees_status ON worktrees(status);

-- ---------- roles ----------

CREATE TABLE roles (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  system_prompt     TEXT NOT NULL DEFAULT '',
  cli_kind          TEXT NOT NULL,
  default_args_json TEXT NOT NULL DEFAULT '[]',
  tool_config_json  TEXT NOT NULL DEFAULT '{}',
  repo_scope_json   TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_roles_user ON roles(user_id);

-- ---------- agents ----------

CREATE TABLE agents (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id           TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  repo_id           TEXT NOT NULL REFERENCES repos(id) ON DELETE RESTRICT,
  worktree_id       TEXT NOT NULL REFERENCES worktrees(id) ON DELETE RESTRICT,
  cli_kind          TEXT NOT NULL,
  tmux_session      TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL CHECK (status IN ('spawning','running','waiting_input','idle','exited','crashed')),
  last_attention_at INTEGER,
  current_task_id   TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_agents_user ON agents(user_id);
CREATE INDEX idx_agents_status ON agents(status);

CREATE TABLE agent_runs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  exit_code  INTEGER,
  reason     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id);

-- ---------- tasks ----------

CREATE TABLE tasks (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id             TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  body                 TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL CHECK (status IN ('queued','active','done','cancelled')),
  assigned_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  completed_at         INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX idx_tasks_agent ON tasks(agent_id);
CREATE INDEX idx_tasks_status ON tasks(status);

-- ---------- terminal log ----------
-- Append-only ring-ish log (pruned per agent by byte budget). One row per chunk.
-- seq is a per-agent monotonic counter assigned by AgentRuntime.
CREATE TABLE terminal_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  chunk      BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_terminal_log_agent_seq ON terminal_log(agent_id, seq);
CREATE INDEX idx_terminal_log_agent_ts ON terminal_log(agent_id, ts);

-- ---------- adapter events ----------

CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts           INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_events_agent_ts ON events(agent_id, ts);

-- ---------- inter-agent messages ----------

CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
  to_agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'text',
  body           TEXT NOT NULL,
  read_at        INTEGER,
  ts             INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_messages_inbox ON messages(to_agent_id, read_at);

-- ---------- alerts ----------

CREATE TABLE alerts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  severity        TEXT NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  reason          TEXT NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  ts              INTEGER NOT NULL,
  acknowledged_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_alerts_agent ON alerts(agent_id, ts);
CREATE INDEX idx_alerts_unack ON alerts(agent_id, acknowledged_at);

-- ---------- push subscriptions ----------

CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  ua         TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);

-- ---------- LLM oversight verdicts ----------

CREATE TABLE llm_oversight_verdicts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL,
  rationale  TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  ts         INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_llm_verdicts_agent_ts ON llm_oversight_verdicts(agent_id, ts);
