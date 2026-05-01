/**
 * Per-agent Claude Code hook settings writer.
 *
 * Claude Code reads `.claude/settings.json` and `.claude/settings.local.json`
 * from the project (worktree) it's running in. For claude-code agents we
 * write a `settings.local.json` registering `Notification` and `PreToolUse`
 * hooks so MAW gets structured JSON about what the agent is doing —
 * `tool_name`, `tool_input.command` for Bash, `tool_input.file_path` for
 * Write, etc — instead of regex-matching the TUI.
 *
 * The hook command is a single-line `curl` POST to
 * `http://127.0.0.1:<port>/api/internal/claude-hook` with a per-agent
 * bearer token. The receiving route enforces loopback-only AND the token
 * (defence-in-depth). The token lives in the file in plaintext — for a
 * self-hosted single-user workbench that is acceptable because file-system
 * ACLs already gate access to the worktree.
 *
 * Naming: we use `settings.local.json` (gitignored by Claude Code's own
 * conventions) so an agent's hook config never leaks into a commit.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface ClaudeHookSettingsOpts {
  worktreePath: string;
  hookToken: string;
  /** MAW server URL the hook will POST to. Always loopback. */
  mawUrl: string;
}

/**
 * Generate a cryptographically random bearer token for a new agent. 32 bytes
 * of entropy → 64 hex chars; comfortably resistant to online brute-force
 * even without rate-limits at the route layer.
 */
export function generateHookToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Write `<worktree>/.claude/settings.local.json` so claude-code, when
 * spawned in `worktreePath`, runs the configured `curl` on every
 * `Notification` and `PreToolUse` event. Idempotent: re-writing on reattach
 * (e.g. after `systemctl restart maw`) refreshes the URL/port if the
 * server now binds differently.
 *
 * The hook payload format Claude Code emits is described at
 * https://code.claude.com/docs/en/hooks.md — the JSON arrives on the
 * hook command's stdin, which the curl below forwards as the request body.
 */
export function writeClaudeHookSettings(opts: ClaudeHookSettingsOpts): void {
  const dir = join(opts.worktreePath, '.claude');
  mkdirSync(dir, { recursive: true });

  const url = `${opts.mawUrl}/api/internal/claude-hook`;
  const authHeader = `Authorization: Bearer ${opts.hookToken}`;

  // POSIX-safe single-line curl. Both header values are single-quoted so
  // the shell doesn't expand `$` if the token ever contains one (it won't
  // — it's hex — but stay defensive). `-fsS` = fail on HTTP error / silent
  // / show errors. `--data-binary @-` reads the JSON event from stdin.
  const command =
    `curl -fsS -X POST ` +
    `-H ${shQuote(authHeader)} ` +
    `-H 'Content-Type: application/json' ` +
    `--data-binary @- ` +
    shQuote(url);

  // Hook config schema (per Claude Code 2.x): each event maps to an array
  // of matcher groups. Empty `matcher` matches everything. Inside each
  // group, `hooks` is an array of `{ type, command }` entries.
  const settings = {
    hooks: {
      Notification: [
        { matcher: '', hooks: [{ type: 'command', command }] }
      ],
      PreToolUse: [
        { matcher: '', hooks: [{ type: 'command', command }] }
      ]
    }
  };

  writeFileSync(
    join(dir, 'settings.local.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf8'
  );
}

/**
 * POSIX single-quote escape: wraps `s` in `'...'`, escaping any inner
 * single quote as `'\''`. The result is safe to splice into a shell
 * command line as a single argument, no matter what `s` contains.
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
