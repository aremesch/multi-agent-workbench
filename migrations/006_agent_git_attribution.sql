-- Multi-Agent Workbench — durable git attribution for agents.
--
-- See docs/plans/v0.2-agent-git-attribution.md for the mechanism design.
-- Attribution is driven by a distinctive committer identity injected into
-- the agent's spawn env (GIT_COMMITTER_NAME/EMAIL). base_sha is the
-- immutable SHA of the default branch at worktree-creation time, kept as
-- a range fallback. Commits are snapshotted into agent_commits at exit
-- and on demand, so the archive survives branch deletion, repo moves,
-- and force-push.

ALTER TABLE agents ADD COLUMN base_sha TEXT;
ALTER TABLE agents ADD COLUMN committer_email TEXT;
ALTER TABLE agents ADD COLUMN head_sha_at_snapshot TEXT;
ALTER TABLE agents ADD COLUMN commits_snapshotted_at INTEGER;

CREATE TABLE agent_commits (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sha             TEXT NOT NULL,
  parent_shas     TEXT NOT NULL DEFAULT '[]',
  author_name     TEXT NOT NULL DEFAULT '',
  author_email    TEXT NOT NULL DEFAULT '',
  committer_name  TEXT NOT NULL DEFAULT '',
  committer_email TEXT NOT NULL DEFAULT '',
  authored_at     INTEGER NOT NULL,
  committed_at    INTEGER NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL
                  CHECK (source IN ('committer','range','merge_base')),
  snapshotted_at  INTEGER NOT NULL,
  position        INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_agent_commits_agent_sha ON agent_commits(agent_id, sha);
CREATE INDEX idx_agent_commits_agent_pos ON agent_commits(agent_id, position);
CREATE INDEX idx_agent_commits_repo ON agent_commits(repo_id);
