-- Multi-Agent Workbench — image attachments on queued tasks.
--
-- See docs/plans/task-list-enhancements.md.
--
-- attachments_json: JSON array of staged image records, each
--   { filename, mime, size, stagedPath }. Files are staged under
--   <dataDir>/task-uploads/<taskId>/ while the task sits in the queue
--   (no worktree exists yet) and copied into the agent's worktree at
--   promote time, with their paths appended to the initial prompt.
--
-- The constant default makes this a safe ADD COLUMN in SQLite — existing
-- rows backfill to '[]'. Never queried by this column, so no index.

ALTER TABLE queue_entries
  ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
