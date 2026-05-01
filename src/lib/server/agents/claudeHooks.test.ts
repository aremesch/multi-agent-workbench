import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateHookToken,
  shQuote,
  writeClaudeHookSettings
} from './claudeHooks.js';

describe('generateHookToken', () => {
  it('returns a 64-char hex string', () => {
    const tok = generateHookToken();
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns distinct tokens on consecutive calls', () => {
    const a = generateHookToken();
    const b = generateHookToken();
    expect(a).not.toBe(b);
  });
});

describe('shQuote', () => {
  it('wraps simple strings in single quotes', () => {
    expect(shQuote('hello')).toBe(`'hello'`);
  });

  it('escapes embedded single quotes via the POSIX \\\'\\\'\\\' trick', () => {
    expect(shQuote("it's fine")).toBe(`'it'\\''s fine'`);
  });

  it('round-trips through `sh -c` for arbitrary inputs', () => {
    // Build a `printf %s` command line and check the result matches the
    // input — that's what we ultimately rely on for the curl args.
    const samples = [
      '',
      'plain',
      `with 'quotes'`,
      `with $vars and \`backticks\``,
      `multi\nline`,
      `unicode: ñ é 中`
    ];
    for (const s of samples) {
      const cmd = `printf %s ${shQuote(s)}`;
      // Use child_process directly so we're not bringing execa noise into
      // the test surface.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      const out = execSync(cmd, { encoding: 'utf8' });
      expect(out).toBe(s);
    }
  });
});

describe('writeClaudeHookSettings', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'maw-hook-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a valid settings.local.json with both hook events', () => {
    writeClaudeHookSettings({
      worktreePath: dir,
      hookToken: 'tok-123',
      mawUrl: 'http://127.0.0.1:5050'
    });

    const path = join(dir, '.claude', 'settings.local.json');
    expect(existsSync(path)).toBe(true);

    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as {
      hooks: {
        Notification: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string }>;
        }>;
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string }>;
        }>;
      };
    };

    expect(parsed.hooks.Notification).toHaveLength(1);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);

    const notifyCmd = parsed.hooks.Notification[0]!.hooks[0]!;
    expect(notifyCmd.type).toBe('command');
    expect(notifyCmd.command).toContain('curl');
    expect(notifyCmd.command).toContain('Bearer tok-123');
    expect(notifyCmd.command).toContain('http://127.0.0.1:5050/api/internal/claude-hook');
    expect(notifyCmd.command).toContain('@-'); // stdin pipe
  });

  it('creates the .claude dir when it does not exist', () => {
    writeClaudeHookSettings({
      worktreePath: dir,
      hookToken: 'tok-x',
      mawUrl: 'http://127.0.0.1:9999'
    });
    expect(existsSync(join(dir, '.claude'))).toBe(true);
  });

  it('is idempotent — re-call rewrites with the new token/url', () => {
    writeClaudeHookSettings({
      worktreePath: dir,
      hookToken: 'tok-old',
      mawUrl: 'http://127.0.0.1:5050'
    });
    writeClaudeHookSettings({
      worktreePath: dir,
      hookToken: 'tok-new',
      mawUrl: 'http://127.0.0.1:6060'
    });
    const raw = readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8');
    expect(raw).toContain('Bearer tok-new');
    expect(raw).toContain(':6060');
    expect(raw).not.toContain('Bearer tok-old');
    expect(raw).not.toContain(':5050');
  });
});
