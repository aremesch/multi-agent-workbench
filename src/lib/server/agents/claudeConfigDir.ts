/**
 * Per-agent isolation of `CLAUDE_CONFIG_DIR`.
 *
 * Background: every claude-code CLI on a host shares one user-global config
 * tree (`~/.claude/` plus `~/.claude.json` at HOME root). On startup, the
 * CLI rewrites `~/.claude.json` via atomic rename. When MAW spawns a new
 * claude-code agent while others are running, that rewrite yanks the
 * config out from under the live processes and they exit. We saw this take
 * down six agents at once in production — see
 * `docs/plans/v0.3-mass-agent-death-incident-investigation-remediation.md`.
 *
 * The fix is to point each agent at its own config dir via
 * `CLAUDE_CONFIG_DIR`. Claude Code honours that env var as the root of the
 * whole tree (`.claude.json`, `projects/`, `sessions/`, `backups/`, …), so
 * the inter-agent race goes away.
 *
 * Seeding strategy:
 *  - COPY the small writable state files (`.claude.json`, `CLAUDE.md`,
 *    `settings.json`, `.credentials.json`) so each agent has its own
 *    independently-mutable copy. `.claude.json` in particular carries
 *    `hasCompletedOnboarding` and the OAuth account ref — without it the
 *    new CLI would launch the subscription/onboarding flow.
 *  - SYMLINK the read-mostly shared dirs (`plugins/`, `plans/`) back to
 *    `~/.claude/` so user-installed plugins and globally-saved plans are
 *    visible to the agent without duplication.
 *
 * Cleanup (`removeAgentClaudeConfigDir`) uses `rm -rf`-style recursive
 * unlink, which removes symlinks WITHOUT following them — the user's
 * `~/.claude/plugins/` is untouched.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getConfig } from '../config.js';

/** Files seeded by copy. `src` is relative to the user's home, `dest` is
 *  relative to the per-agent config dir. `.claude.json` sits at HOME root,
 *  the rest live inside `~/.claude/`. */
const SEED_FILES: Array<{ src: string; dest: string }> = [
  { src: '.claude.json', dest: '.claude.json' },
  { src: '.claude/CLAUDE.md', dest: 'CLAUDE.md' },
  { src: '.claude/settings.json', dest: 'settings.json' },
  { src: '.claude/.credentials.json', dest: '.credentials.json' }
];

/** Dirs symlinked to the user-global tree. Read-mostly, shared across
 *  agents by design. */
const SEED_SYMLINKS: Array<{ src: string; dest: string }> = [
  { src: '.claude/plugins', dest: 'plugins' },
  { src: '.claude/plans', dest: 'plans' }
];

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

  const home = homedir();
  for (const { src, dest } of SEED_FILES) {
    const srcAbs = join(home, src);
    if (!existsSync(srcAbs)) continue;
    try {
      copyFileSync(srcAbs, join(dir, dest));
    } catch (err) {
      console.warn(
        `[claudeConfigDir] failed to seed ${dest} for ${agentId}:`,
        (err as Error).message
      );
    }
  }

  for (const { src, dest } of SEED_SYMLINKS) {
    const srcAbs = join(home, src);
    const destAbs = join(dir, dest);
    if (!existsSync(srcAbs)) continue;
    try {
      // Idempotent: drop any prior entry (symlink, file, or dir) before
      // (re-)creating the symlink. `rmSync` with `force: true` does NOT
      // descend into symlink targets — only the link itself is removed,
      // so the user-global `~/.claude/plugins/` stays intact.
      rmSync(destAbs, { recursive: true, force: true });
      symlinkSync(srcAbs, destAbs, 'dir');
    } catch (err) {
      console.warn(
        `[claudeConfigDir] failed to symlink ${dest} for ${agentId}:`,
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
