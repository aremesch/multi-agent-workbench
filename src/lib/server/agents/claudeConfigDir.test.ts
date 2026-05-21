import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock state — vi.mock callbacks run before any other top-level
// code, so a plain `let dataDir` is unset at that moment. Using a holder
// object means we can swap dataDir per-test via the mutable property.
const cfg = { dataDir: '' };
vi.mock('../config.js', () => ({
  getConfig: () => ({ dataDir: cfg.dataDir })
}));

// Stub `os.homedir` so we can point seeding at a controlled fake home.
// Vitest preserves the module identity, so the SUT and this test see the
// same overridden function.
const homeHolder = { home: '' };
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => homeHolder.home
  };
});

import {
  agentClaudeConfigDir,
  ensureAgentClaudeConfigDir,
  removeAgentClaudeConfigDir
} from './claudeConfigDir.js';

let workRoot: string;

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'maw-claude-cfgdir-'));
  cfg.dataDir = join(workRoot, 'data');
  homeHolder.home = join(workRoot, 'home');
  mkdirSync(cfg.dataDir, { recursive: true });
  mkdirSync(join(homeHolder.home, '.claude'), { recursive: true });
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

describe('agentClaudeConfigDir', () => {
  it('returns a deterministic path rooted in dataDir/agents/<id>/claude', () => {
    expect(agentClaudeConfigDir('01ABC')).toBe(join(cfg.dataDir, 'agents', '01ABC', 'claude'));
  });
});

describe('ensureAgentClaudeConfigDir', () => {
  it('creates the config dir tree', () => {
    const dir = ensureAgentClaudeConfigDir('01ABC');
    expect(existsSync(dir)).toBe(true);
  });

  it('copies seed files (CLAUDE.md, settings.json, .credentials.json) from ~/.claude when present', () => {
    writeFileSync(join(homeHolder.home, '.claude', 'CLAUDE.md'), 'user prefs');
    writeFileSync(join(homeHolder.home, '.claude', 'settings.json'), '{"x":1}');
    writeFileSync(join(homeHolder.home, '.claude', '.credentials.json'), 'auth');

    const dir = ensureAgentClaudeConfigDir('01DEF');

    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('user prefs');
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{"x":1}');
    expect(readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe('auth');
  });

  it('silently skips seed files that do not exist in ~/.claude', () => {
    // No seed files written — function still succeeds, just produces an
    // empty dir.
    const dir = ensureAgentClaudeConfigDir('01GHI');
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('is idempotent: calling twice does not throw and re-seeds the latest user-global value', () => {
    writeFileSync(join(homeHolder.home, '.claude', 'CLAUDE.md'), 'v1');
    ensureAgentClaudeConfigDir('01JKL');
    writeFileSync(join(homeHolder.home, '.claude', 'CLAUDE.md'), 'v2');
    const dir = ensureAgentClaudeConfigDir('01JKL');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('v2');
  });

  it('isolates two agents: writes to one do not affect the other', () => {
    const a = ensureAgentClaudeConfigDir('agent-A');
    const b = ensureAgentClaudeConfigDir('agent-B');
    expect(a).not.toBe(b);
    writeFileSync(join(a, '.claude.json'), 'A-config');
    writeFileSync(join(b, '.claude.json'), 'B-config');
    expect(readFileSync(join(a, '.claude.json'), 'utf8')).toBe('A-config');
    expect(readFileSync(join(b, '.claude.json'), 'utf8')).toBe('B-config');
  });
});

describe('removeAgentClaudeConfigDir', () => {
  it('removes the agent\'s config dir tree', () => {
    const dir = ensureAgentClaudeConfigDir('01MNO');
    writeFileSync(join(dir, '.claude.json'), '{}');
    mkdirSync(join(dir, 'projects', 'foo'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'foo', 'x.jsonl'), '');

    removeAgentClaudeConfigDir('01MNO');

    expect(existsSync(dir)).toBe(false);
  });

  it('removes the agent\'s parent dir when empty after claude/ goes', () => {
    ensureAgentClaudeConfigDir('01PQR');
    removeAgentClaudeConfigDir('01PQR');
    expect(existsSync(join(cfg.dataDir, 'agents', '01PQR'))).toBe(false);
  });

  it('leaves the agent\'s parent dir alone if it has siblings to claude/', () => {
    const dir = ensureAgentClaudeConfigDir('01STU');
    // Drop a sibling file under the parent — this stands in for "future
    // per-agent state that isn't claude/".
    writeFileSync(join(dir, '..', 'other'), 'sibling');
    removeAgentClaudeConfigDir('01STU');
    expect(existsSync(join(cfg.dataDir, 'agents', '01STU', 'other'))).toBe(true);
  });

  it('does not throw when the dir does not exist', () => {
    expect(() => removeAgentClaudeConfigDir('does-not-exist')).not.toThrow();
  });
});
