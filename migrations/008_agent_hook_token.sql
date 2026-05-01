-- Multi-Agent Workbench — durable per-agent hook bearer token.
--
-- See docs/plans/v0.2-rich-input-notifications.md. Used by claude-code's
-- Notification / PreToolUse hooks to authenticate POSTs to the localhost
-- /api/internal/claude-hook endpoint so MAW can detect "agent is waiting
-- on user input" with structured JSON (tool_name, tool_input.command,
-- tool_use_id) instead of regex-matching the TUI. The token is generated
-- once at agent spawn and lives in the worktree's
-- .claude/settings.local.json (gitignored, never committed).
--
-- Defence-in-depth: the receiving route also enforces loopback-only via
-- getClientAddress() — token + loopback together gate the endpoint.

ALTER TABLE agents ADD COLUMN hook_token TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_hook_token
  ON agents(hook_token)
  WHERE hook_token IS NOT NULL;
