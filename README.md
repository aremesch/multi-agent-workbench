# Multi-Agent Workbench (MAW)

Self-hosted web workbench that orchestrates multiple LLM coding-agent CLIs
(Claude Code, Codex, Gemini CLI, …) in parallel across one or more git
repos. Each agent runs inside its own `tmux` session in an isolated git
worktree. The backend reattaches to surviving sessions across restarts,
streams live terminal output over WebSocket to a SvelteKit frontend, and
pushes permission-prompt alerts to an installable PWA on your phone.

Two driving goals:

1. **Phone-first multi-agent management** — install the PWA, get Web Push
   notifications for permission prompts, tap to approve from anywhere.
2. **Daily browser workbench** — log in once, resume seamlessly, see
   every agent's live terminal side by side.

## PWA & push notifications

MAW's headline feature: install it on your phone, get push notifications
when an agent needs attention, tap to jump straight to that agent's
terminal.

1. **Install.** Open the deployed URL in Android Chrome or desktop
   Chrome/Edge and pick *Install app*. The manifest
   (`static/manifest.webmanifest`) and service worker
   (`src/service-worker.ts`) drive installability; an offline fallback
   page is cached at install time.
2. **Enable push.** Go to *Settings → Notifications*, grant permission,
   and subscribe. Requires VAPID keys on the server — see the
   [Environment](#environment) section.
3. **What you get notified about.** Permission prompts, idle waiting,
   crashes, errors — detected per adapter. Tapping a notification opens
   the PWA on the agent that needs attention.
4. **HTTPS is required.** Service workers and Web Push only work over
   HTTPS (localhost is exempt for dev). Put MAW behind a TLS-terminating
   reverse proxy (Caddy, nginx, Cloudflare Tunnel) for phone installs.
5. **Per-spawn control.** The spawn form lets you toggle adapter flags
   like Claude Code's `--dangerously-skip-permissions`. Turn it off if
   you want the agent to actually prompt — that's what drives the push.

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
- **Service worker** (`src/service-worker.ts`) + web app manifest for
  PWA install, offline fallback, and push/notificationclick handling.
- **`web-push`** for VAPID-signed Web Push fan-out from the backend.
- **Production bundle** via `esbuild`: `pnpm build` emits a single
  `build/server.js` that wraps the SvelteKit handler with the `/ws`
  listener. Native addons (`better-sqlite3`, `@node-rs/argon2`) stay
  external; prod hosts don't need `tsx` or the `src/` tree.
- **i18n** with `en` / `de` / `fr` / `es` locales under `src/lib/i18n/`.

## Repository layout

```
cli-adapters/        JSONC adapter definitions (claude-code, codex, gemini, shell)
docs/plans/          Persisted plans (see the Plans section below)
migrations/          Hand-written NNN_*.sql migrations
schemas/             JSON Schema for adapter configs
scripts/             migrate.ts, test-adapter.ts
static/              PWA manifest, icons, offline fallback
src/service-worker.ts  Install / fetch / push / notificationclick
src/lib/server/      AgentSupervisor, WorktreeManager, FifoStreamer, DB, auth
src/lib/server/push/ PushService + alert fan-out (VAPID / web-push)
src/lib/client/      xterm wrapper, shared WS client
src/lib/i18n/        Locale bundles (en / de / fr / es)
src/lib/shared/      Types shared between client and server
src/routes/          SvelteKit routes (login, dashboard, repos, settings, api)
server.js            adapter-node handler + ws server + boot sequence
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
# MAW_BOOTSTRAP_PASSWORD. Generate VAPID keys if you want push:
#   pnpm dlx web-push generate-vapid-keys
pnpm migrate
pnpm dev
```

Open the URL `pnpm dev` prints (Vite defaults to
http://127.0.0.1:5173) and log in with the bootstrap credentials
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
- `MAW_VAPID_PUBLIC_KEY` / `MAW_VAPID_PRIVATE_KEY` / `MAW_VAPID_SUBJECT`
  — Web Push credentials. Generate a keypair with
  `pnpm dlx web-push generate-vapid-keys`. `MAW_VAPID_SUBJECT` must be
  a `mailto:` address or an `https://` URL. Leaving all three blank
  disables push cleanly; the rest of the app still runs.

## Adapters

A CLI adapter is a JSONC file under `cli-adapters/` that tells MAW how
to launch a coding-agent CLI and how to interpret its output (prompt
detection, permission prompts, idle state). The registry is hot-reloaded
on change. `cli-adapters/shell.jsonc` is a minimal smoke adapter that
runs a plain `bash` session — useful for testing the pipeline without
installing `claude`, `codex`, or `gemini`.

Validate changes against `schemas/adapter.schema.json`; try them with
`pnpm test:adapter`.

## Plans

Persisted plans live in [`docs/plans/`](docs/plans/). Git history is the
activity log; plan files are the design record.
