-- Multi-Agent Workbench — track the CLI's own session id alongside the agent.
--
-- Plumbed for `claude --session-id <uuid>` so the JSONL transcript path
-- (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`) is deterministic from
-- spawn time, no filesystem-watch race. Nullable for adapters that don't
-- have or need a CLI-side session handle (smoke shell, future Codex/Gemini
-- until they get their own readers).

ALTER TABLE agents ADD COLUMN cli_session_id TEXT;
