# Fix: spawned claude-code agents start logged out (401 "Please run /login")

> **Pre-implementation rename (per global plan rules — match branch/worktree `fix-login`):**
> - file → `docs/plans/fix-login.md` (use `git mv`)
> - branch/worktree already named `fix-login`

## Context

Spawning any fresh `claude-code` agent (e.g. `polyrepo-support`) prints the banner, then the first API call fails:

```
⎿  Please run /login · API Error: 401 Invalid authentication credentials
```

This persists **even though the previous fix** ([v0.3-fix-claude-code-spawn-fails-with-401-empty-api-key-stale-cop](done/v0.3-fix-claude-code-spawn-fails-with-401-empty-api-key-stale-cop.md)) already (1) stopped passing `ANTHROPIC_API_KEY=""` and (2) switched `.credentials.json` from copy to **symlink** so all agents would share one OAuth file.

### Why the symlink fix doesn't hold — confirmed by on-disk evidence

Each claude-code agent runs with its own `CLAUDE_CONFIG_DIR` (`<dataDir>/agents/<id>/claude/`) — required to stop the `.claude.json` atomic-rewrite race that mass-killed agents. The prior fix symlinks `<configDir>/.credentials.json` → `~/.claude/.credentials.json`.

But **Claude Code writes credentials via `tmp → rename(2)`** on every `/login` and every token refresh. `rename(2)` replaces the **symlink itself** with a private regular file — it does not write through the link. So the new token is trapped in that one agent's dir and the shared `~/.claude/.credentials.json` never updates. Inspecting live agent dirs:

| Agent | `.credentials.json` | sha256 | mtime |
|---|---|---|---|
| global `~/.claude` | (source) | `a650…` | Jun 1 22:18 |
| `01KT4BTNT7…` | **symlink → global** | `a650…` (matches) | not yet refreshed |
| `01KT4C17EW…` | **regular file** | `c741…` (diverged) | Jun 2 16:33 |
| `01KT49FHAN…` | **regular file** | `6177…` (diverged) | Jun 2 15:52 |

Two agents independently rewrote their credentials; **neither propagated back to the global**, which is now stale. The failure loop:

1. Agent spawns → symlink → reads the **stale** global creds.
2. Access token expired → CLI refreshes using the global's refresh token → writes via rename → **symlink clobbered**, fresh token trapped locally.
3. Claude's OAuth rotates the refresh token on use, so the global's refresh token is now **dead**.
4. Next spawn symlinks to the now-dead global → **401**. Running `/login` inside an agent only heals that one agent's private copy, never the global — so the next spawn breaks again.

The symlink "single source of truth" assumption is fundamentally incompatible with atomic-rename writes.

### The supported fix

Claude Code reads **`CLAUDE_CODE_OAUTH_TOKEN`** (a long-lived, ~1-year, inference-scoped subscription token from `claude setup-token`) directly as a bearer token — **no `.credentials.json` read, no file write, no refresh-token rotation**. Passing it in each spawn's env makes auth a static, stateless value that survives any number of concurrent/sequential spawns. This account is `subscriptionType: max`, so the subscription token is the right vehicle (not a pay-per-token Console key).

**Decisions (confirmed with user):**
- **Token primary, API key override**: plumb `CLAUDE_CODE_OAUTH_TOKEN` as the default; keep `ANTHROPIC_API_KEY` working as an override for anyone who sets a real Console key. (Claude precedence: `ANTHROPIC_API_KEY` > `CLAUDE_CODE_OAUTH_TOKEN` > `.credentials.json`, so passing both is safe.)
- **Remove** the now-defeated `.credentials.json` symlink seeding.

## Changes

### 1 — Read the token in config

`src/lib/server/config.ts`:
- Add `claudeCodeOauthToken: string;` to the `AppConfig` interface (near `anthropicApiKey`, ~line 56).
- Read it alongside the API key (~line 102): `claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? '',`.

### 2 — Pass it into the spawn spec

`src/lib/server/agents/AgentSupervisor.ts` (the `buildSpawnSpec({... env: {...} })` block at lines 622-626):

```ts
env: {
  ANTHROPIC_API_KEY: cfg.anthropicApiKey,
  CLAUDE_CODE_OAUTH_TOKEN: cfg.claudeCodeOauthToken,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? ''
},
```

### 3 — Declare it in the adapter env template

`cli-adapters/claude-code.jsonc` (spawn.env, lines 43-45):

```jsonc
"env": {
  "ANTHROPIC_API_KEY": "{{env.ANTHROPIC_API_KEY}}",
  "CLAUDE_CODE_OAUTH_TOKEN": "{{env.CLAUDE_CODE_OAUTH_TOKEN}}"
},
```

The existing empty-skip filter in `ConfigDrivenAdapter.ts:194-201` drops whichever of these resolves to `''`, so an unset token (or unset key) is never passed as `KEY=""`. No transport change needed.

### 4 — Remove the defeated credential symlink seeding

`src/lib/server/agents/claudeConfigDir.ts`:
- Delete the `{ src: '.claude/.credentials.json', dest: '.credentials.json' }` entry from `SEED_SYMLINKS` (lines 69-73). Keep `plugins` and `plans`.
- Update the header doc comment (lines 17-37) and the `SEED_SYMLINKS` comment (lines 63-68): remove the `.credentials.json` rationale; note that auth now comes from the `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` spawn env, not from a seeded credentials file. `.claude.json` stays a **copy** (carries `hasCompletedOnboarding` + account ref so the CLI skips onboarding).

### 5 — Document the env var

`.env.example` — replace the bare `ANTHROPIC_API_KEY=` block (lines 94-97) with an agent-auth section documenting the token as primary:

```
# --- Agent CLI auth ---
# Subscription login shared by every spawned claude-code agent. Generate once:
#   claude setup-token        # ~1-year, inference-scoped token tied to your Max plan
# Without this (and without a Console key below), agents spawn logged out → 401.
CLAUDE_CODE_OAUTH_TOKEN=
# Optional Console API key. If set, OVERRIDES the OAuth token above and bills
# pay-per-token instead of using the subscription.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
```

## Tests

- **`src/lib/server/agents/adapters/ConfigDrivenAdapter.test.ts`** — in the claude-code block (~line 620), mirror the existing `ANTHROPIC_API_KEY` empty/non-empty pair for the new var:
  - omits `CLAUDE_CODE_OAUTH_TOKEN` from `spec.env` when its templated value is empty;
  - passes it through when non-empty.
- **`src/lib/server/agents/claudeConfigDir.test.ts`** — drop `.credentials.json` from the asserted-symlinked set; assert the per-agent dir gets **no** `.credentials.json` symlink/file from seeding. Keep `plugins`/`plans` symlink assertions and the `.claude.json`/`CLAUDE.md`/`settings.json` copy assertions.

## Files touched

- `src/lib/server/config.ts`
- `src/lib/server/agents/AgentSupervisor.ts`
- `cli-adapters/claude-code.jsonc`
- `src/lib/server/agents/claudeConfigDir.ts`
- `.env.example`
- the two test files above

## Provisioning (one-time, on the production host — outside the code change)

1. As the `maw` user: `claude setup-token` → copy the printed token.
2. Add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `/home/maw/.env` (loaded by `deploy/systemd/maw.service` via `EnvironmentFile`).
3. `systemctl restart maw.service`.

## Verification

1. **Unit:** `pnpm test src/lib/server/agents/adapters/ConfigDrivenAdapter.test.ts src/lib/server/agents/claudeConfigDir.test.ts` — new cases pass, existing stay green.
2. **Type check:** `pnpm check`.
3. **Live spawn smoke test** (after provisioning + restart):
   - Spawn a fresh claude-code agent from the web UI.
   - `ps -wwfC claude -o command=` (or `tmux -L maw show-environment -t maw-agent-…`) → confirm `CLAUDE_CODE_OAUTH_TOKEN=…` is present and **no** `ANTHROPIC_API_KEY=""`.
   - `ls -la <dataDir>/agents/<new-id>/claude/` → confirm there is **no** `.credentials.json` symlink (seeding removed); `plugins`/`plans` still symlinked; `.claude.json` still a copy.
   - Send a prompt in the agent → normal response, **not** `Please run /login`.
4. **Sequential-spawn regression** (the original failure): spawn agent A, let it run, then spawn agent B several minutes later. Both authenticate on first call with no `/login`. Re-run a third spawn after an hour to confirm no token-rotation regression.
5. **Override path:** set a real `ANTHROPIC_API_KEY` in `/home/maw/.env`, restart, spawn — confirm the key is present in the env and used (key-based auth), token still passed but overridden.
