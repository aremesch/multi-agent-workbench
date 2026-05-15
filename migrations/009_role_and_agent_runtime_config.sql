-- Multi-Agent Workbench — per-role defaults + per-agent runtime-config columns.
--
-- See docs/plans/v0.2-spawn-dialog-redesign-agent-roles-management.md.
--
-- roles.default_model           Adapter-specific model id picked when this
--                               role is the active one in the spawn dialog
--                               (e.g. claude-code 'opus' / 'sonnet'). Null
--                               means "use the adapter's default".
-- roles.default_permission_mode Adapter-specific permission/approval mode
--                               (e.g. claude-code 'plan' / 'acceptEdits').
--                               Null means "use the adapter's default".
-- agents.model / .permission_mode  The values actually chosen at spawn time
--                               (after the user's per-spawn overrides). Frozen
--                               on the row so the archive page can show what
--                               configuration this agent ran with.
-- agents.source_branch          The branch the worktree (or repo, in
--                               with_worktree=false mode) was created from.
--                               Distinct from worktrees.branch which is the
--                               branch the worktree IS on, not its start point.

ALTER TABLE roles  ADD COLUMN default_model           TEXT;
ALTER TABLE roles  ADD COLUMN default_permission_mode TEXT;

ALTER TABLE agents ADD COLUMN model            TEXT;
ALTER TABLE agents ADD COLUMN permission_mode  TEXT;
ALTER TABLE agents ADD COLUMN source_branch    TEXT;
