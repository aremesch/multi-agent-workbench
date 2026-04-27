-- Multi-Agent Workbench — browser-agent target URL.
--
-- See docs/plans/v0.3-browser-agent.md. The "browser" agent type displays an
-- iframe preview of a localhost dev server through MAW's same-origin reverse
-- proxy at /preview/<agentId>/*. target_url is captured from the spawn form
-- (e.g. http://localhost:5173); target_port is parsed out so the proxy can
-- forward to 127.0.0.1:<port> without re-parsing on every request.
--
-- Both columns are NULL for non-browser agents. tmux_session keeps its
-- NOT NULL UNIQUE constraint — browser agents store a sentinel value
-- (`browser-<agentId>`) so the supervisor can branch on cli_kind without
-- needing a 12-step rebuild here.

ALTER TABLE agents ADD COLUMN target_url TEXT;
ALTER TABLE agents ADD COLUMN target_port INTEGER;
