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

- v0.1 foundation + CRUD UI landed, `pnpm check` clean (0/0).
- Full create flow in SvelteKit form actions: project → repo → role →
  spawn agent, reachable from the dashboard. Pre-generated `agentId`
  keeps worktree dir, branch (`maw/<agentId>`) and DB row in lock-step.
- Repo attach is self-healing: empty dirs get `git init -b <default>` +
  empty initial commit; unborn repos get HEAD re-pointed and seeded;
  legacy `master` is renamed to the project default (`main`);
  non-empty non-git dirs are rejected. Helper lives in WorktreeManager.
- Terminal view now uses xterm.js (dynamic-imported for SSR safety).
  Raw PTY bytes flow as `Uint8Array` so UTF-8 multibyte sequences decode
  correctly. Client-side keystrokes (arrows, Ctrl-C, etc.) forward as a
  new `send_keys` WS message → `AgentRuntime.enqueueRawKeys` →
  `tmux send-keys -l`, preserving VT220 escape sequences verbatim.
- FifoStreamer fixed: dropped `O_NONBLOCK` (kept `O_RDWR`) so libuv does
  blocking reads in the threadpool instead of crashing on EAGAIN.
- Smoke adapter `cli-adapters/shell.jsonc` exercises the pipeline end
  to end without needing claude/codex/gemini installed.
- Backend skeleton (auth, SQLite+migrations, tmux+FIFO, supervisor with
  reattach-on-boot, ConfigDrivenAdapter + hot-reloading registry, WS
  hub) unchanged and still clean.
- Not yet: edit/delete flows, PWA + service worker + Web Push, alert
  pipeline, MCP server, `maw` CLI binary, LLM overseer, tuned
  claude-code/codex/gemini adapter patterns.

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
- **Persistence:** Plan files land directly in `docs/plans/` via the
  `plansDirectory` setting in `.claude/settings.json` — no manual copy
  step. **Immediately after plan approval** (before starting
  implementation), rename the auto-generated plan file to the repo
  convention `v0.X-<kebab-topic>.md` (e.g. `v0.1-dashboard-v2.md`) so
  it matches the other entries in the index below. Use `git mv`.
  Commit the plan file alongside the implementation, or in its own
  `docs: plan` commit if the plan itself lands first.
- **Sync:** Reflect completed tasks in this file immediately after a successful build.

## Development Plans

Persisted roadmaps live in [`docs/plans/`](docs/plans/).

- [`docs/plans/v0.1-foundation.md`](docs/plans/v0.1-foundation.md) — original v0.1 design & scope (executed).
- [`docs/plans/v0.1-crud-ui.md`](docs/plans/v0.1-crud-ui.md) — housekeeping + full CRUD UI for projects/repos/roles/spawn agent (executed).
- [`docs/plans/v0.1-dashboard-v2.md`](docs/plans/v0.1-dashboard-v2.md) — gridstack dashboard, per-agent thumbnails, modal terminal, archive drawer, spawn-form modal, supervisor reaper, tmux resize sync (executed).
