/**
 * Per-agent isolation of `CLAUDE_CONFIG_DIR`.
 *
 * Background: every claude-code CLI on a host shares one user-global config
 * tree (`~/.claude/`, with `~/.claude.json` as the canonical state file).
 * On startup, the CLI rewrites `~/.claude.json` via atomic rename. When MAW
 * spawns a new claude-code agent while others are running, that rewrite
 * yanks the config out from under the live processes and they exit. We saw
 * this take down six agents at once in production — see
 * `docs/plans/v0.3-mass-agent-death-incident-investigation-remediation.md`.
 *
 * The fix is to point each agent at its own config dir via
 * `CLAUDE_CONFIG_DIR`. Claude Code honours that env var as the root of the
 * whole tree (`.claude.json`, `projects/`, `sessions/`, `backups/`, …), so
 * the inter-agent race goes away.
 *
 * The dir is seeded by COPY (not symlink) from `~/.claude/` for the three
 * files claude-code expects: `CLAUDE.md`, `settings.json`, and
 * `.credentials.json` (so the agent inherits user prefs and stays logged
 * in). We don't symlink because writes against the canonical files would
 * re-introduce the race we are trying to kill.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  rmSync,
  statSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getConfig } from '../config.js';

/** Files copied (not symlinked) from `~/.claude/` so each agent starts
 *  with user prefs + auth but writes stay isolated. */
const SEED_FILES = ['CLAUDE.md', 'settings.json', '.credentials.json'] as const;

/** Absolute path of the isolated claude config dir for an agent. */
export function agentClaudeConfigDir(agentId: string): string {
  return join(getConfig().dataDir, 'agents', agentId, 'claude');
}

/**
 * Create the per-agent config dir (idempotent), seed it from the user-global
 * `~/.claude/` tree, and return its absolute path. Safe to call on reattach:
 * existing files are overwritten with the current user-global values, which
 * matches the "start each spawn with the latest creds" semantic we want.
 *
 * Seeding errors are non-fatal — we log and continue. claude-code will
 * bootstrap any missing files itself; the agent just won't inherit the
 * user's existing login until they paste a token.
 */
export function ensureAgentClaudeConfigDir(agentId: string): string {
  const dir = agentClaudeConfigDir(agentId);
  mkdirSync(dir, { recursive: true });

  const userClaude = join(homedir(), '.claude');
  for (const f of SEED_FILES) {
    const src = join(userClaude, f);
    if (!existsSync(src)) continue;
    try {
      copyFileSync(src, join(dir, f));
    } catch (err) {
      console.warn(
        `[claudeConfigDir] failed to seed ${f} for ${agentId}:`,
        (err as Error).message
      );
    }
  }

  return dir;
}

/**
 * Remove the per-agent config dir. Called from the supervisor's
 * `finishAsExited` and `kill` paths. Errors are swallowed and logged:
 * leaving a stale dir behind is a tolerable leak, but throwing here would
 * abort the agent's exit transition and leave the row in the wrong state.
 *
 * Cleans the agent's parent dir too (`<dataDir>/agents/<agentId>/`) so we
 * don't accumulate empty per-agent directories. The parent's `rmSync` is
 * guarded against a non-empty dir in case future code stashes other
 * per-agent data alongside `claude/`.
 */
export function removeAgentClaudeConfigDir(agentId: string): void {
  const dir = agentClaudeConfigDir(agentId);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[claudeConfigDir] failed to remove ${dir}:`,
      (err as Error).message
    );
    return;
  }

  // Best-effort parent cleanup. `rmdirSync` (the legacy API, not
  // `rmSync(path)` which errors on directories without `recursive`)
  // throws `ENOTEMPTY` on a non-empty dir — that's what we want, so any
  // future per-agent data living alongside `claude/` does not get nuked.
  const parent = join(getConfig().dataDir, 'agents', agentId);
  try {
    if (statSync(parent).isDirectory()) {
      rmdirSync(parent);
    }
  } catch {
    // Parent missing, non-empty, or any other error: ignore. The
    // per-agent claude dir is gone, which is the contract.
  }
}
