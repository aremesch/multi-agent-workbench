-- Multi-Agent Workbench — Backlog vs. Queue split + plan capture.
--
-- See docs/plans/v0.2-split-the-task-list-from-the-run-queue-plan-capture.md.
--
-- queued: separates the user's intent ("should auto-run when capacity opens")
-- from the lifecycle status. Existing rows are migrated as queued = 1 to
-- preserve current behavior; new rows default to 0 (backlog) — the spawn
-- dialog promotes to queue only via the explicit "Run" submit button or
-- POST /api/queue/:id/queue.
--
-- plan_md: snapshot of a markdown plan captured at task-creation time. When
-- present, spawnFromInputs concatenates it after the task body before sending
-- to the agent.
--
-- plan_source_path: optional reference to where the plan came from (e.g.
-- "docs/plans/v0.2-foo.md"). Schema-only for now — no UI to set it manually
-- in v0.3.

ALTER TABLE queue_entries
  ADD COLUMN queued INTEGER NOT NULL DEFAULT 1 CHECK (queued IN (0,1));

ALTER TABLE queue_entries
  ADD COLUMN plan_md TEXT;

ALTER TABLE queue_entries
  ADD COLUMN plan_source_path TEXT;

CREATE INDEX idx_queue_entries_user_queued_status
  ON queue_entries(user_id, queued, status);
