# Multi-Agent Workbench (MAW)

## Project

Self-hosted web workbench that orchestrates multiple LLM coding-agent CLIs
(Claude Code, Codex, Gemini CLI, …) in parallel across one or more git repos.
Each agent runs inside its own tmux session in an isolated git worktree; the
backend reattaches to surviving sessions across restarts, streams live
terminal output over WebSocket to a SvelteKit frontend, and (at v0.2) sends
Web Push alerts to a PWA on the user's phone so they can answer permission
prompts from anywhere.

Two driving goals:

1. **Phone-first multi-agent management** — install the PWA, get push
   notifications for permission prompts, tap to approve from anywhere.
2. **Daily browser workbench** — log in once, resume seamlessly, see every
   agent's live terminal side by side.

## Current status

- v0.1 scaffold builds, `pnpm check` is clean, login works, dashboard reads
  empty state (no create-forms yet).
- Backend skeleton complete: SQLite + hand-written migrations, auth
  (argon2id + session cookie + CSRF), tmux + FIFO streamer,
  `AgentSupervisor` with reattach-on-boot, `ConfigDrivenAdapter` +
  hot-reloading `AdapterRegistry`, WebSocket hub implementing the full
  `ClientMessage`/`ServerMessage` protocol.
- CLI adapter configs present for `claude-code`, `codex`, `gemini` —
  starter patterns only, must be tuned against real recorded sessions.
- Not yet implemented: create-forms for projects/repos/roles/agents,
  xterm.js rendering (placeholder `<pre>` for now), PWA + service
  worker + Web Push, alert pipeline, MCP server, `maw` CLI binary,
  LLM overseer.

> Keep this section terse and *replace* its contents as work lands.
> Do not append completed items — git history is the activity log.

## Guidelines

- **🚨 NEVER commit credentials, secrets, tokens, API keys, passwords,
  or connection strings.** They belong only in `.env` (gitignored).
  Never paste them into source files, migrations, comments, commit
  messages, `CLAUDE.md`, or anywhere else that is or could become
  tracked. When you need to connect to the database or another
  service, source `.env` at call time — do not inline the value.
  If you ever notice a credential in a tracked file or staged change,
  stop immediately, remove it, and tell the user.
- **🚨 NEVER modify or "fix" shadcn-svelte components.** Files under
  `src/lib/components/ui/` are vendored from upstream and must be
  treated as generated code. Do not hand-edit them — not to silence
  type errors, not to tweak styling, not for anything. The only
  permitted way to change them is to refresh from upstream:
  `pnpm dlx shadcn-svelte@latest add -y -o <component>...`
  (the `-o` flag overwrites in place). If a component appears broken,
  refresh it; if it is still broken after refresh, that is an upstream
  bug or a config/registry mismatch — fix the cause, not the file.
- **Planning:** Always update "Development Plans" before executing complex changes.
- **Persistence:** Save finalized roadmaps to `docs/plans/` if they exceed 50 lines.
- **Sync:** Reflect completed tasks in this file immediately after a successful build.

## Development Plans

Persisted roadmaps live in [`docs/plans/`](docs/plans/).

- [`docs/plans/v0.1-foundation.md`](docs/plans/v0.1-foundation.md) — original v0.1 design & scope (executed).
- [`docs/plans/v0.1-crud-ui.md`](docs/plans/v0.1-crud-ui.md) — housekeeping + full CRUD UI for projects/repos/roles/spawn agent (current).
