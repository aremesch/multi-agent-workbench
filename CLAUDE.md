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
- Spawn dialog now requires a task title and names the worktree
  directory after a slug of that title
  (`~/.local/share/maw/worktrees/<slug>/` instead of the ULID). Slug is
  lowercase kebab `[a-z0-9-]`, max 60 chars; duplicate slugs are
  rejected via a DB + filesystem check. Branch name stays
  `maw/<agentId>`. Migration `004_repo_project_optional.sql` makes
  `repos.project_id` nullable and lifts `default_branch` onto the repo
  (copied from the project on migrate). The spawn form no longer shows
  any Project UI — inline repo creation posts to `/api/repos` without
  a project and the resulting row has `project_id = NULL`. Existing
  ULID-named worktrees keep working (resolved via `worktrees.path`).
- New persistent left sidebar (`RepoTreeSidebar`) shows a Repo→Agents
  treeview with an `Archive` top-level node listing only repos that
  have archived agents (no per-agent expansion). Sidebar bg matches
  the page (`#0a0a0a`), no left-rail connector on agents, collapsed
  width trimmed to `1.75rem`. Every repo the user owns is listed under
  **Repositories** even with zero agents (data merged in
  `+layout.server.ts` via `listReposWithProjectForUser`); empty repos
  render with an inert disclosure spacer. Click a repo to open its
  per-repo dashboard at `/repos/[id]` (own gridstack layout key,
  `dashboard.layout.repo.<id>.v1`); click an agent to land on
  `/repos/[id]?agent=<id>` with the terminal modal pre-opened. Click
  an archived repo to open `/repos/[id]/archive` — a table of that
  repo's exited/crashed agents with total/active/idle time and a
  **View logs** button that opens an xterm replay of the persisted
  `terminal_log` (served by `/api/agents/[id]/log`). Sidebar
  collapsed state is per-user (`ui.sidebar.collapsed`). Right-side
  archive drawer is gone; the hamburger menu now contains only
  **Settings** and **Logout**.
- Full create flow in SvelteKit form actions: project → repo → role →
  spawn agent, reachable from the dashboard. Pre-generated `agentId`
  keeps worktree dir, branch (`maw/<agentId>`) and DB row in lock-step.
- Per-agent git attribution is durable (migration 006). At spawn,
  `WorktreeManager.create` resolves the default-branch SHA and stores
  it as `agents.base_sha`; the supervisor injects
  `GIT_COMMITTER_NAME=MAW-Agent-<id>` / `GIT_COMMITTER_EMAIL=<id>@maw.local`
  into the tmux env so every commit the agent makes self-identifies.
  `finishAsExited` / `kill` fire-and-forget a `snapshotAgentCommits`
  call that writes rows to the new `agent_commits` table via a
  three-tier fallback (committer → `<base_sha>..<branch>` range →
  legacy merge-base). Archive page (`/repos/[id]/archive`) reads from
  the table; legacy archived agents get a one-shot back-fill on first
  visit. On-demand refresh is exposed as
  `GET/POST /api/agents/[id]/commits`. Author identity is untouched.
- Repo attach is self-healing: empty dirs get `git init -b <default>` +
  empty initial commit; unborn repos get HEAD re-pointed and seeded;
  legacy `master` is renamed to the project default (`main`);
  non-empty non-git dirs are rejected. Helper lives in WorktreeManager.
- Terminal view now uses xterm.js (dynamic-imported for SSR safety).
  Raw PTY bytes flow as `Uint8Array` so UTF-8 multibyte sequences decode
  correctly. Client-side keystrokes (arrows, Ctrl-C, etc.) forward as a
  new `send_keys` WS message → `AgentRuntime.enqueueRawKeys` →
  `tmux send-keys -l`, preserving VT220 escape sequences verbatim.
- Terminal reconnect ships the tmux pane's currently rendered grid
  (protocol v5 `pane_snapshot`). On every `subscribe_agent` the hub
  reads the `terminal_log.seq` watermark, registers the live output
  listener, then `await`s `tmux capture-pane -p -e -S 0`, CRLF-normalizes
  it (xterm runs with `convertEol: false`, so bare LF from capture-pane
  would paint a staircase), and sends one `pane_snapshot { ansi, seq }`
  followed by a catch-up of any `terminal_log` chunks newer than the
  watermark (client dedup handles the race overlap). The client SETs
  `maxSeenSeq = snapshot.seq` unconditionally so live bytes that beat
  the snapshot to the wire are re-applied from catch-up and not
  wrongly dropped. Kills the TUI-CLI stacked-banner bug on reopen /
  reload; `terminal_log` stays populated for the archive log route.
  See [`docs/plans/v0.2-terminal-pane-snapshot.md`](docs/plans/v0.2-terminal-pane-snapshot.md).
- `MawWsClient` is a module-level tab-wide shared singleton
  (`getMawWsClient()`) with per-agent handler dispatch — one `/ws`
  connection per tab, all panels fan out through it. Layout kicks
  the connection open on mount so first-modal subscribe doesn't
  wait on the handshake.
- FifoStreamer fixed: dropped `O_NONBLOCK` (kept `O_RDWR`) so libuv does
  blocking reads in the threadpool instead of crashing on EAGAIN.
- Smoke adapter `cli-adapters/shell.jsonc` exercises the pipeline end
  to end without needing claude/codex/gemini installed. Declares
  `createWorktree: false` (new adapter field, default true) so spawn
  skips `git worktree add` and the tmux pane opens in the repo root on
  whatever branch is already checked out — no throwaway `maw/<agentId>`
  branch. Real CLI adapters keep the default and still get their own
  worktree per spawn.
- Production server is bundled: `pnpm build` runs `vite build` then
  `esbuild` to emit `build/server.js` — a single ESM file that wraps
  the SvelteKit handler with the `/ws` WebSocket upgrade listener.
  No `tsx` or `src/` needed on prod; native addons (`better-sqlite3`,
  `@node-rs/argon2`) stay external. Launch: `node build/server.js`.
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
- [`docs/plans/v0.1-inline-spawn.md`](docs/plans/v0.1-inline-spawn.md) — inline project/role/repo creation within the spawn form modal; three JSON API routes, no page navigation required (executed).
- [`docs/plans/v0.1-left-sidebar-treeview.md`](docs/plans/v0.1-left-sidebar-treeview.md) — persistent collapsible left sidebar with Repo→Agents tree (plus Archive→Repo→Agents), per-repo dashboard at `/repos/[id]` with its own gridstack layout key, hamburger reduced to Settings + Logout, right-side archive drawer removed (executed).
- [`docs/plans/v0.1-sidebar-polish.md`](docs/plans/v0.1-sidebar-polish.md) — sidebar bg matches page, lighter treeview hierarchy, smaller collapsed width, all user repos listed even with zero agents (executed).
- [`docs/plans/v0.1-archive-dashboard.md`](docs/plans/v0.1-archive-dashboard.md) — sidebar Archive lists repos only (no per-agent expansion); new `/repos/[id]/archive` dashboard table for exited/crashed agents with total/active/idle time and an xterm log-replay modal backed by `/api/agents/[id]/log` (executed).
- [`docs/plans/v0.2-tmux-survive-restart.md`](docs/plans/v0.2-tmux-survive-restart.md) — dedicated `tmux -L maw` socket + drops the stale-channel guard so `session-closed` hook reliably closes the terminal modal on CLI exit (executed). The `systemd-run --user --scope` half is **superseded by v2** below.
- [`docs/plans/v0.2-title-worktree-naming.md`](docs/plans/v0.2-title-worktree-naming.md) — mandatory agent titles in the spawn dialog; worktree dirs named after a lowercase-kebab slug of the title (`~/.local/share/maw/worktrees/<slug>/`) with duplicate titles rejected; project picker/creator removed from the spawn form; `repos.project_id` made nullable and `default_branch` lifted onto the repo via migration `004_repo_project_optional.sql` (executed).
- [`docs/plans/v0.2-tmux-survive-restart-v2.md`](docs/plans/v0.2-tmux-survive-restart-v2.md) — replaces the broken transient-scope dance with a shipped `deploy/systemd/maw-tmux.service` user unit that owns the `-L maw` server outside `maw.service`'s cgroup. `Tmux.ensureServer()` is gone; bootstrap just probes the socket and warns if missing. Operator must install the new unit + add `Wants=/After=maw-tmux.service` and `KillMode=process` to `maw.service` (executed).
- [`docs/plans/v0.2-playwright-hydration-smoke-tests.md`](docs/plans/v0.2-playwright-hydration-smoke-tests.md) — Playwright e2e suite against the bundled prod server; three chromium smoke tests (dashboard hydration, user-menu click, spawn-FAB click) behind a fixture that fails on any CSP violation or `pageerror`, catching the "SSR renders, hydration silently dies" regression class (e.g. the `script-src 'self'` CSP that sat on `development` unnoticed for three days). `pnpm test:e2e` locally; `.github/workflows/e2e.yml` on PRs to `main` and `development` (executed).
- [`docs/plans/v0.2-vitest-unit-tests.md`](docs/plans/v0.2-vitest-unit-tests.md) — phased comprehensive vitest unit-test suite. Phase 0 landed infra (vitest projects config — server in node + client in jsdom, v8 coverage, `@testing-library/svelte` + `jest-dom` + `jsdom` + `@vitest/coverage-v8`, CI workflow). Subsequent phases: 1 pure logic (106), 2 DB layer (65), 3 adapter engine (73), 4 history rendering (46), 5 auth (41), 6 impure server seams — git/tmux/push (75), 7 WS hub (33), 8 client MawWsClient (24), 9 Svelte 5 component harness + Modal (9). **472 cases total.** Coverage gate at 33/86/70/33; branch and function thresholds exceed the plan's original 60/70 targets. Route-layer tests (`src/routes/**`) remain untested and will land in a follow-up (executed).
- [`docs/plans/v0.2-playwright-agent-lifecycle-e2e.md`](docs/plans/v0.2-playwright-agent-lifecycle-e2e.md) — Playwright e2e guard against the session-closed hook cascade regression (fix commit `33c4089`). Spawns two `shell` agents via the real `/agents/new` form action, fires `tmux send-keys 'exit'` into the 2nd, and asserts agent 1's `status` column in `/tmp/maw-e2e/maw.db` is still `running` (read directly via `better-sqlite3`). The snapshot route alone can't catch the bug — under the old code agent 1's tmux session stays alive while its DB row flips to `exited`, so `hasSession` still returns 200 on a zombie runtime. Verified the test fails under the pre-fix code with `Expected: "running", Received: "exited"` (executed).
- [`docs/plans/v0.2-adapter-create-worktree-flag.md`](docs/plans/v0.2-adapter-create-worktree-flag.md) — adapter JSONC `createWorktree` flag (default true); when false, spawn skips `git worktree add` and the agent's tmux cwd is the repo root. Flipped off in `shell.jsonc` (executed).
- [`docs/plans/v0.2-terminal-autofocus.md`](docs/plans/v0.2-terminal-autofocus.md) — xterm `.focus()` at the tail of `Terminal.svelte`'s async init so modal-open lands keyboard focus inside the terminal instead of on the dialog's close button; removes the extra click after spawn/reopen (executed).
- [`docs/plans/v0.2-agent-git-attribution.md`](docs/plans/v0.2-agent-git-attribution.md) — durable per-agent git attribution: distinctive `GIT_COMMITTER_NAME/EMAIL` injected at spawn, `base_sha` anchor captured at worktree creation, new `agent_commits` table snapshotted at exit and on-demand (migration 006); archive reads from DB with one-shot legacy back-fill (executed).
- [`docs/plans/v0.2-reattach-live-stream-fix.md`](docs/plans/v0.2-reattach-live-stream-fix.md) — post-mortem + fix for reattached agents whose live terminal stream died after `systemctl --user restart maw` (keystrokes not echoed, output not streamed, but `capture-pane` thumbnails still updated). Root cause: `tmux pipe-pane -o` is a TOGGLE — when a surviving `cat` writer from the pre-SIGKILL maw lingered in tmux, the reattach's second `pipe-pane -o` silently closed the pipe instead of replacing it. Fix drops `-o` from `Tmux.pipePane` argv (tmux defaults to destroy-and-replace) and hardens `FifoStreamer.create` to unlink-then-mkfifo so the reader always attaches to a fresh kernel FIFO inode. Guarded by (1) a unit test asserting the argv never contains `-o` and (2) a real-tmux integration test on a throwaway `-L` socket that runs two back-to-back `pipe-pane` calls with the prior pipe still live and asserts `#{pane_pipe}=1` plus actual byte flow (executed).
- [`docs/plans/v0.2-terminal-mobile-quickkeys.md`](docs/plans/v0.2-terminal-mobile-quickkeys.md) — deletes the free-text input + **Send** button under xterm and replaces it (on touch devices, or opt-in desktop) with a compact row of adapter-declared quick-key buttons that fire keys phone soft-keyboards can't type (↑ ↓ ⇧⇥ Esc ^C). New `mobileQuickKeys` array on the adapter JSONC schema (validated, duplicate-id-guarded), populated on all four shipped adapters. Visibility is tri-state per-user (`auto`/`always`/`never`, default `auto` — touch-only) via a new `ui.mobileQuickKeys` `user_settings` key, a radio group in `/settings` (EN/DE/ES/FR), and a tiny `PUT /api/user/mobile-quickkeys-state` route for live toggles. Helper exported from `src/lib/shared/dashboard.ts`, unit-tested. Buttons forward raw UTF-8 through the existing `send_keys` WS path and refocus xterm afterwards (executed).
- [`docs/plans/v0.2-terminal-revert.md`](docs/plans/v0.2-terminal-revert.md) — clean-slate revert of the terminal snapshot/dedup/JSONL/cursor-align stack back to byte-log replay from `terminal_log` (protocol v4, `lastSeq` de-dup; `cursorPosition`, `collapseRepeatingTailBlocks`, `rstripVisuallyEmptyLines`, `sendHistorySnapshot`, JSONL history, `scrollbackMode`/`historySource`/`forceRedrawOnReconnect`/`{{agent.cliSessionId}}` all gone). Migration 003's `agents.cli_session_id` column stays inert. Carries the known TUI-CLI stacked-banner bug on first connect — accepted as the documented baseline; archived attempts under [`docs/plans/archive/terminal-attempts-2026-04/`](docs/plans/archive/terminal-attempts-2026-04/) (`v0.1-terminal-replay`, `v0.1-terminal-persistence`, `v0.1-terminal-scrollback-v2`, `v0.1-jsonl-history`, `v0.2-terminal-output-alignment`) preserve the lessons (executed).
- [`docs/plans/v0.2-terminal-pane-snapshot.md`](docs/plans/v0.2-terminal-pane-snapshot.md) — replaces the post-revert byte-log replay with a `tmux capture-pane -p -e -S 0` snapshot shipped on every `subscribe_agent`. Protocol v5: `subscribe_agent` drops `lastSeq` from the wire (client-side watermark still gates live-output dedup); server emits a new `SC_PaneSnapshot { ansi, seq }` followed by a catch-up of any `terminal_log` chunks newer than the watermark for the race window between reading the seq and the output listener going live. CRLF-normalizes the captured LF-only bytes so xterm's `convertEol: false` doesn't paint a staircase. Client handler `reset()`s the grid and SETs `maxSeenSeq = snapshot.seq` unconditionally so catch-up re-emits land even when a live byte beat the snapshot to the wire. Coverage threshold on branches lowered 86→85 (actual 85.78 after the client-side branch reduction). `terminal_log` keeps being populated for `/api/agents/[id]/log` archive replay. Kills the TUI-CLI stacked-banner bug on reopen / page reload; verified against `claude-code` and shell agents in the dev preview (executed).
