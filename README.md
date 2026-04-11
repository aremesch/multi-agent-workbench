# Multi-Agent Workbench (MAW)

Self-hosted web workbench that orchestrates multiple LLM coding-agent CLIs
(Claude Code, Codex, Gemini CLI, …) in parallel across one or more git
repos. Each agent runs inside its own `tmux` session in an isolated git
worktree. The backend reattaches to surviving sessions across restarts,
streams live terminal output over WebSocket to a SvelteKit frontend, and
(v0.2) will push permission-prompt alerts to a PWA on your phone.

Two driving goals:

1. **Phone-first multi-agent management** — install the PWA, get Web Push
   notifications for permission prompts, tap to approve from anywhere.
2. **Daily browser workbench** — log in once, resume seamlessly, see
   every agent's live terminal side by side.

## Status

v0.1 foundation + CRUD UI. `pnpm check` clean.

- Create flow in SvelteKit form actions: project → repo → role → spawn
  agent, all reachable from the dashboard.
- Repo attach is self-healing: empty dirs get `git init`, unborn repos
  are seeded, legacy `master` is renamed to the project default, and
  non-empty non-git dirs are rejected.
- Terminal view uses `xterm.js` (dynamic-imported for SSR safety) with
  raw PTY bytes over WebSocket so UTF-8 multibyte sequences decode
  correctly. Client keystrokes forward through a `send_keys` WS message
  to `tmux send-keys -l`, preserving VT220 escape sequences.
- FIFO streamer uses blocking reads in the libuv threadpool (no
  `O_NONBLOCK`) so it can't crash on `EAGAIN`.
- Smoke adapter `cli-adapters/shell.jsonc` exercises the pipeline end
  to end without needing `claude` / `codex` / `gemini` installed.

Not yet: edit/delete flows, PWA + service worker + Web Push, alert
pipeline, MCP server, `maw` CLI binary, LLM overseer, tuned
claude-code/codex/gemini adapter patterns.

## Stack

- **SvelteKit** fullstack (TypeScript strict) on Node 22 via
  `@sveltejs/adapter-node`, with a custom `server.js` that mounts a raw
  `ws` WebSocket server on the same HTTP listener.
- **SQLite** via `better-sqlite3`, hand-written migrations under
  `migrations/`, typed row helpers — no ORM.
- **tmux + FIFO** for agent sessions (`pipe-pane` → named pipe →
  `AgentRuntime`). State lives in tmux + SQLite so the backend can
  crash, redeploy, or upgrade and reattach on boot without losing any
  agent.
- **xterm.js** in the browser; shadcn-svelte + Tailwind for UI.
- **Argon2id** password auth + signed httpOnly session cookie.
- **Config-driven CLI adapters** (`cli-adapters/*.jsonc`, validated
  against `schemas/adapter.schema.json`) hot-reloaded via `chokidar`.

## Repository layout

```
cli-adapters/     JSONC adapter definitions (claude-code, codex, gemini, shell)
docs/plans/       Persisted roadmaps (v0.1-foundation, v0.1-crud-ui, …)
migrations/       Hand-written NNN_*.sql migrations
schemas/          JSON Schema for adapter configs
scripts/          migrate.ts, test-adapter.ts
src/lib/server/   AgentSupervisor, WorktreeManager, FifoStreamer, DB, auth
src/lib/client/   xterm wrapper, WS client
src/lib/shared/   Types shared between client and server
src/routes/       SvelteKit routes (login, dashboard, projects, roles, agents)
server.js         adapter-node handler + ws server + boot sequence
```

## Prerequisites

- Node.js 22 LTS and `pnpm`
- `git` and `tmux` on `PATH`
- Local (non-NFS) disk for SQLite WAL and FIFOs

MAW is Linux-first. macOS works. **Windows is not supported** — the
agent runtime depends on `tmux` and POSIX named pipes (FIFOs), neither
of which exist natively on Windows. Use WSL2 if you must, and treat it
as Linux.

### Ubuntu 24.04

Ubuntu 24.04's default `apt` repo ships Node 18, so Node 22 comes from
NodeSource (or `nvm` / `fnm` if you prefer a version manager).

```bash
# system packages
sudo apt update
sudo apt install -y git tmux curl ca-certificates

# Node.js 22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm via Corepack (bundled with Node 22)
sudo corepack enable
corepack prepare pnpm@latest --activate

# verify
node --version   # v22.x
pnpm --version
tmux -V
git --version
```

If `pnpm install` ever falls back to building `better-sqlite3` from
source, also install a C/C++ toolchain and Python:

```bash
sudo apt install -y build-essential python3
```

### macOS (13+, Apple Silicon or Intel)

Install via [Homebrew](https://brew.sh):

```bash
# Homebrew itself (skip if already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# runtime + tools
brew install node@22 pnpm tmux git

# node@22 is keg-only; link it so `node` resolves to v22
brew link --overwrite --force node@22

# verify
node --version   # v22.x
pnpm --version
tmux -V
git --version
```

If a native module ever falls back to a source build, install the
Xcode Command Line Tools:

```bash
xcode-select --install
```

## Quickstart

```bash
pnpm install
cp .env.example .env
# edit .env — at minimum set MAW_SESSION_SECRET and pick a
# MAW_BOOTSTRAP_PASSWORD; leave VAPID keys blank until v0.2
pnpm migrate
pnpm dev
```

Open http://127.0.0.1:3000 and log in with the bootstrap credentials
from `.env`. Create a project, point it at a git repo (or an empty
directory — MAW will `git init` it), add a role, then spawn an agent.
The terminal view will attach to the live tmux session.

For a production-ish run against the built bundle:

```bash
pnpm build
pnpm start        # runs server.js directly
```

## Scripts

| Command                | What it does                                  |
|------------------------|-----------------------------------------------|
| `pnpm dev`             | Vite dev server with HMR                      |
| `pnpm build`           | Production build                              |
| `pnpm start`           | Run `server.js` (adapter-node + ws)           |
| `pnpm check`           | `svelte-kit sync` + `svelte-check`            |
| `pnpm migrate`         | Apply pending SQL migrations                  |
| `pnpm test`            | Vitest                                        |
| `pnpm test:adapter`    | Exercise an adapter end-to-end via `shell`    |
| `pnpm lint` / `format` | ESLint / Prettier                             |

## Environment

All configuration lives in `.env`. See `.env.example` for the full list
— notable entries:

- `MAW_DATA_DIR` — SQLite + push-subscription state. **Must be local
  disk.** SQLite WAL does not work on NFS.
- `MAW_FIFO_DIR` — one named pipe per agent, local disk only.
- `MAW_WORKTREE_ROOT` — where agent worktrees are checked out.
- `MAW_BOOTSTRAP_USERNAME` / `MAW_BOOTSTRAP_PASSWORD` — seeded only on
  first boot against an empty DB; change via the UI afterwards.
- `MAW_SESSION_SECRET` — 32 random bytes (base64) for signing cookies.
- `MAW_VAPID_*` — Web Push keys, used in v0.2.

**Never commit `.env` or any credential.** See `CLAUDE.md` for the full
rules.

## Adapters

A CLI adapter is a JSONC file under `cli-adapters/` that tells MAW how
to launch a coding-agent CLI and how to interpret its output (prompt
detection, permission prompts, idle state). The registry is hot-reloaded
on change. `cli-adapters/shell.jsonc` is a minimal smoke adapter that
runs a plain `bash` session — useful for testing the pipeline without
installing `claude`, `codex`, or `gemini`.

Validate changes against `schemas/adapter.schema.json`; try them with
`pnpm test:adapter`.

## Roadmap

Persisted plans live in [`docs/plans/`](docs/plans/):

- [`v0.1-foundation.md`](docs/plans/v0.1-foundation.md) — original v0.1
  design & scope (executed).
- [`v0.1-crud-ui.md`](docs/plans/v0.1-crud-ui.md) — housekeeping + full
  CRUD UI for projects/repos/roles/spawn agent (current).

v0.2 and beyond: PWA + service worker + Web Push, alert pipeline, MCP
server, `maw` CLI binary, LLM overseer, tuned adapter patterns for
claude-code / codex / gemini.

## Contributing notes

- **Never hand-edit files under `src/lib/components/ui/`** — they are
  vendored shadcn-svelte and must be refreshed from upstream via
  `pnpm dlx shadcn-svelte@latest add -y -o <component>`.
- Update `CLAUDE.md`'s "Current status" section *in place* as work
  lands; git history is the activity log.
- Roadmaps >50 lines belong in `docs/plans/`.
