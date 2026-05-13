/**
 * Unit tests for the plan-discovery + render helpers.
 *
 * Strategy: mock the simple-git client factory so git invocations are
 * scripted, mock `node:fs/promises` so the readFile/readdir/stat/realpath
 * calls are scripted too, and mock `node:os.homedir` so the global plans
 * dir is deterministic (`/home/test/.claude/plans`). Lets us exercise the
 * diff-vs-fallback fork, the local+global merge, settings.json
 * resolution, the realpath/symlink TOCTOU defence and the markdown
 * render+sanitize pipeline without touching disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimpleGit } from 'simple-git';

// Mock the simple-git client BEFORE importing the SUT.
const revparseMock = vi.fn();
const diffMock = vi.fn();
const statusMock = vi.fn();
const getGitMock = vi.fn();
vi.mock('$lib/server/git/client', () => ({
  getGit: (cwd?: string) => getGitMock(cwd)
}));

// Mock node:fs/promises with per-test settings.
const readFileMock = vi.fn();
const readdirMock = vi.fn();
const statMock = vi.fn();
const realpathMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (p: string, enc?: string) => readFileMock(p, enc),
  readdir: (p: string) => readdirMock(p),
  stat: (p: string) => statMock(p),
  realpath: (p: string) => realpathMock(p)
}));

// Pin homedir so global-plans path is `/home/test/.claude/plans`.
vi.mock('node:os', () => ({
  homedir: () => '/home/test'
}));

import {
  displayDir,
  listAgentPlans,
  renderAgentPlan,
  resolvePlansDir
} from './agentPlans.js';

const GLOBAL_DIR = '/home/test/.claude/plans';
const LOCAL_DIR_ABS = '/wt/docs/plans';
/** Default agent-creation timestamp used by tests (ms since epoch). */
const AGENT_CREATED_MS = 10_000_000;
/** Skew buffer used by the SUT — keep in sync with agentPlans.ts. */
const GLOBAL_MTIME_SKEW_MS = 60_000;

beforeEach(() => {
  revparseMock.mockReset();
  diffMock.mockReset();
  statusMock.mockReset();
  getGitMock.mockReset();
  getGitMock.mockReturnValue({
    revparse: revparseMock,
    diff: diffMock,
    status: statusMock
  } as unknown as SimpleGit);
  readFileMock.mockReset();
  readdirMock.mockReset();
  statMock.mockReset();
  realpathMock.mockReset();
  // Default realpath = identity (no symlinks). Tests override per-case.
  realpathMock.mockImplementation((p: string) => Promise.resolve(p));
  // Default: global plans dir is empty unless the test sets it up.
  readdirMock.mockImplementation((p: string) =>
    p === GLOBAL_DIR ? Promise.resolve([]) : Promise.reject(new Error('ENOENT'))
  );
});
afterEach(() => {
  vi.clearAllMocks();
});

/** Helper: stat result that just sets mtime + size. */
function fakeStat(mtimeMs: number, size: number) {
  return { mtimeMs, size };
}

/**
 * Helper: scripted readdir for two paths (local + global). Either side
 * can be `null` to mean "ENOENT" (dir missing).
 */
function scriptDirs(localEntries: string[] | null, globalEntries: string[] | null) {
  readdirMock.mockImplementation((p: string) => {
    if (p === LOCAL_DIR_ABS) {
      return localEntries === null
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(localEntries);
    }
    if (p === GLOBAL_DIR) {
      return globalEntries === null
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(globalEntries);
    }
    return Promise.reject(new Error(`unexpected readdir: ${p}`));
  });
}

describe('resolvePlansDir', () => {
  it('falls back to docs/plans when settings.json is missing', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT'));
    expect(await resolvePlansDir('/wt')).toBe('docs/plans');
  });

  it('falls back when settings.json is malformed JSON', async () => {
    readFileMock.mockResolvedValue('{ not json');
    expect(await resolvePlansDir('/wt')).toBe('docs/plans');
  });

  it('falls back when plansDirectory key is missing', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ env: {} }));
    expect(await resolvePlansDir('/wt')).toBe('docs/plans');
  });

  it('falls back when plansDirectory is not a string', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ plansDirectory: 42 }));
    expect(await resolvePlansDir('/wt')).toBe('docs/plans');
  });

  it('uses a custom relative path when present and safe', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ plansDirectory: 'design/plans' }));
    expect(await resolvePlansDir('/wt')).toBe('design/plans');
  });

  it('rejects absolute paths', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ plansDirectory: '/etc/passwd' }));
    expect(await resolvePlansDir('/wt')).toBe('docs/plans');
  });

  it('rejects path traversal segments', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ plansDirectory: '../etc' }));
    expect(await resolvePlansDir('/wt')).toBe('docs/plans');
  });

  it('rejects empty / dot-only / suspicious chars', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ plansDirectory: '   ' }));
    expect(await resolvePlansDir('/wt')).toBe('docs/plans');
    readFileMock.mockResolvedValue(JSON.stringify({ plansDirectory: './' }));
    expect(await resolvePlansDir('/wt')).toBe('docs/plans');
    readFileMock.mockResolvedValue(JSON.stringify({ plansDirectory: 'plans;rm' }));
    expect(await resolvePlansDir('/wt')).toBe('docs/plans');
  });
});

describe('displayDir', () => {
  it('returns plansDir for local source', () => {
    expect(displayDir('local', 'docs/plans')).toBe('docs/plans');
    expect(displayDir('local', 'design/plans')).toBe('design/plans');
  });
  it('returns ~/.claude/plans for global source regardless of plansDir', () => {
    expect(displayDir('global', 'docs/plans')).toBe('~/.claude/plans');
    expect(displayDir('global', 'anything')).toBe('~/.claude/plans');
  });
});

describe('listAgentPlans (local-only behaviour preserved)', () => {
  it('returns [] when the local plans dir does not exist (and global empty)', async () => {
    scriptDirs(null, []);
    expect(await listAgentPlans('/wt', 'docs/plans', null, AGENT_CREATED_MS)).toEqual([]);
  });

  it('returns [] when no markdown files in either dir', async () => {
    scriptDirs(['README', 'config.json'], []);
    expect(await listAgentPlans('/wt', 'docs/plans', null, AGENT_CREATED_MS)).toEqual([]);
  });

  it('lists ALL local .md when baseSha is null and tags them source=local', async () => {
    scriptDirs(['v0.1.md', 'v0.2.md', 'README'], []);
    statMock.mockImplementation((p: string) =>
      Promise.resolve(p.endsWith('v0.2.md') ? fakeStat(2000, 50) : fakeStat(1000, 30))
    );
    const out = await listAgentPlans('/wt', 'docs/plans', null, AGENT_CREATED_MS);
    expect(out.map((s) => s.name)).toEqual(['v0.2.md', 'v0.1.md']); // sorted desc
    expect(out[0]!.source).toBe('local');
    expect(out[0]!.modifiedMs).toBe(2000);
    expect(out[0]!.sizeBytes).toBe(50);
    expect(getGitMock).not.toHaveBeenCalled();
  });

  it('falls back to ALL local .md when base_sha does not resolve', async () => {
    scriptDirs(['a.md'], []);
    statMock.mockResolvedValue(fakeStat(1000, 10));
    revparseMock.mockRejectedValue(new Error('unknown revision'));
    const out = await listAgentPlans('/wt', 'docs/plans', 'deadbeef', AGENT_CREATED_MS);
    expect(out.map((s) => s.name)).toEqual(['a.md']);
    expect(out[0]!.source).toBe('local');
    // After the rev-parse failure, we shouldn't have called diff or status.
    expect(revparseMock).toHaveBeenCalledTimes(1);
    expect(diffMock).not.toHaveBeenCalled();
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('filters local by git diff + status when base_sha resolves', async () => {
    scriptDirs(['kept.md', 'unchanged.md', 'staged.md'], []);
    statMock.mockImplementation((p: string) => {
      if (p.endsWith('kept.md')) return Promise.resolve(fakeStat(3000, 1));
      if (p.endsWith('staged.md')) return Promise.resolve(fakeStat(2000, 2));
      return Promise.resolve(fakeStat(1000, 3));
    });
    revparseMock.mockResolvedValue('BASE\n');
    // Committed change to kept.md — newline-separated diff --name-only output.
    diffMock.mockResolvedValue('docs/plans/kept.md\n');
    // Uncommitted addition of staged.md — structured status response.
    statusMock.mockResolvedValue({
      files: [{ path: 'docs/plans/staged.md', index: '?', working_dir: '?' }]
    });
    const out = await listAgentPlans('/wt', 'docs/plans', 'BASE', AGENT_CREATED_MS);
    expect(out.map((s) => s.name)).toEqual(['kept.md', 'staged.md']);
    expect(out.every((s) => s.source === 'local')).toBe(true);
  });

  it('handles multi-file diff output (regression guard for separator bugs)', async () => {
    scriptDirs(['one.md', 'two.md', 'unchanged.md'], []);
    statMock.mockImplementation((p: string) => {
      if (p.endsWith('one.md')) return Promise.resolve(fakeStat(3000, 1));
      if (p.endsWith('two.md')) return Promise.resolve(fakeStat(2000, 1));
      return Promise.resolve(fakeStat(1000, 1));
    });
    revparseMock.mockResolvedValue('BASE\n');
    diffMock.mockResolvedValue('docs/plans/one.md\ndocs/plans/two.md\n');
    statusMock.mockResolvedValue({ files: [] });
    const out = await listAgentPlans('/wt', 'docs/plans', 'BASE', AGENT_CREATED_MS);
    expect(out.map((s) => s.name).sort()).toEqual(['one.md', 'two.md']);
  });

  it('skips files that vanish between readdir and stat', async () => {
    scriptDirs(['a.md', 'gone.md'], []);
    statMock.mockImplementation((p: string) =>
      p.endsWith('gone.md')
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(fakeStat(1, 1))
    );
    const out = await listAgentPlans('/wt', 'docs/plans', null, AGENT_CREATED_MS);
    expect(out.map((s) => s.name)).toEqual(['a.md']);
  });

  it('rejects readdir entries with unsafe filenames (defensive)', async () => {
    scriptDirs(['ok.md', '../escape.md', '.hidden.md'], []);
    statMock.mockResolvedValue(fakeStat(1, 1));
    const out = await listAgentPlans('/wt', 'docs/plans', null, AGENT_CREATED_MS);
    expect(out.map((s) => s.name)).toEqual(['ok.md']);
  });
});

describe('listAgentPlans — global plans (~/.claude/plans)', () => {
  it('surfaces a recent global plan when local is empty', async () => {
    scriptDirs([], ['recent.md']);
    statMock.mockResolvedValue(fakeStat(AGENT_CREATED_MS + 5_000, 42));
    const out = await listAgentPlans('/wt', 'docs/plans', null, AGENT_CREATED_MS);
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe('recent.md');
    expect(out[0]!.source).toBe('global');
  });

  it('excludes a global plan older than created_at − 60s', async () => {
    scriptDirs([], ['old.md']);
    // Just barely outside the −60s window.
    statMock.mockResolvedValue(
      fakeStat(AGENT_CREATED_MS - GLOBAL_MTIME_SKEW_MS - 1, 10)
    );
    const out = await listAgentPlans('/wt', 'docs/plans', null, AGENT_CREATED_MS);
    expect(out).toEqual([]);
  });

  it('skew boundary: file at exactly created_at − 60s is included, − 60s − 1ms is excluded', async () => {
    scriptDirs([], ['edge-in.md', 'edge-out.md']);
    statMock.mockImplementation((p: string) =>
      Promise.resolve(
        p.endsWith('edge-in.md')
          ? fakeStat(AGENT_CREATED_MS - GLOBAL_MTIME_SKEW_MS, 1)
          : fakeStat(AGENT_CREATED_MS - GLOBAL_MTIME_SKEW_MS - 1, 1)
      )
    );
    const out = await listAgentPlans('/wt', 'docs/plans', null, AGENT_CREATED_MS);
    expect(out.map((s) => s.name)).toEqual(['edge-in.md']);
  });

  it('treats a missing ~/.claude/plans dir as no global plans (no throw)', async () => {
    scriptDirs(['local.md'], null);
    statMock.mockResolvedValue(fakeStat(AGENT_CREATED_MS + 1_000, 5));
    const out = await listAgentPlans('/wt', 'docs/plans', null, AGENT_CREATED_MS);
    expect(out.map((s) => s.name)).toEqual(['local.md']);
    expect(out[0]!.source).toBe('local');
  });

  it('merges local + global, sorted by mtime desc, with correct source tags', async () => {
    scriptDirs(['l-old.md', 'l-new.md'], ['g-old.md', 'g-new.md']);
    statMock.mockImplementation((p: string) => {
      if (p.endsWith('/wt/docs/plans/l-new.md')) {
        return Promise.resolve(fakeStat(AGENT_CREATED_MS + 4_000, 1));
      }
      if (p.endsWith('/wt/docs/plans/l-old.md')) {
        return Promise.resolve(fakeStat(AGENT_CREATED_MS + 1_000, 1));
      }
      if (p === `${GLOBAL_DIR}/g-new.md`) {
        return Promise.resolve(fakeStat(AGENT_CREATED_MS + 3_000, 1));
      }
      if (p === `${GLOBAL_DIR}/g-old.md`) {
        // Outside the skew window → should be filtered out.
        return Promise.resolve(fakeStat(AGENT_CREATED_MS - GLOBAL_MTIME_SKEW_MS - 1, 1));
      }
      return Promise.reject(new Error(`unexpected stat: ${p}`));
    });
    const out = await listAgentPlans('/wt', 'docs/plans', null, AGENT_CREATED_MS);
    expect(out.map((s) => ({ name: s.name, source: s.source }))).toEqual([
      { name: 'l-new.md', source: 'local' },
      { name: 'g-new.md', source: 'global' },
      { name: 'l-old.md', source: 'local' }
    ]);
  });
});

describe('renderAgentPlan — local source (default)', () => {
  it('throws invalid_filename for path traversal attempts', async () => {
    await expect(
      renderAgentPlan('/wt', 'docs/plans', '../etc/passwd.md')
    ).rejects.toThrow('invalid_filename');
    await expect(renderAgentPlan('/wt', 'docs/plans', 'dir/file.md')).rejects.toThrow(
      'invalid_filename'
    );
    await expect(renderAgentPlan('/wt', 'docs/plans', '.hidden.md')).rejects.toThrow(
      'invalid_filename'
    );
  });

  it('throws invalid_filename for files without .md extension', async () => {
    await expect(renderAgentPlan('/wt', 'docs/plans', 'plan.txt')).rejects.toThrow(
      'invalid_filename'
    );
  });

  it('returns null when the file does not exist on disk', async () => {
    // realpath rejects (ENOENT) for the candidate file path.
    realpathMock.mockImplementation((p: string) =>
      p === LOCAL_DIR_ABS ? Promise.resolve(p) : Promise.reject(new Error('ENOENT'))
    );
    expect(await renderAgentPlan('/wt', 'docs/plans', 'gone.md')).toBeNull();
  });

  it('returns null when the source dir itself does not exist', async () => {
    realpathMock.mockRejectedValue(new Error('ENOENT'));
    expect(await renderAgentPlan('/wt', 'docs/plans', 'plan.md')).toBeNull();
  });

  it('renders headings, lists, and code blocks to HTML', async () => {
    readFileMock.mockResolvedValue('# Title\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n');
    const out = await renderAgentPlan('/wt', 'docs/plans', 'plan.md');
    expect(out).not.toBeNull();
    expect(out!.name).toBe('plan.md');
    expect(out!.html).toContain('<h1');
    expect(out!.html).toContain('Title');
    expect(out!.html).toContain('<li>one</li>');
    expect(out!.html).toContain('<code');
  });

  it('strips <script> tags', async () => {
    readFileMock.mockResolvedValue('# heading\n\n<script>alert(1)</script>\n\nbody text');
    const out = await renderAgentPlan('/wt', 'docs/plans', 'evil.md');
    expect(out!.html).not.toContain('<script');
    expect(out!.html).not.toContain('alert(1)');
    expect(out!.html).toContain('body text');
  });

  it('strips inline event handlers like onerror=', async () => {
    readFileMock.mockResolvedValue('# h\n\n<img src=x onerror="fetch(\'evil\')">\n');
    const out = await renderAgentPlan('/wt', 'docs/plans', 'evil.md');
    expect(out!.html).not.toContain('onerror');
    expect(out!.html).not.toContain("fetch('evil')");
  });

  it('strips javascript: URLs from anchors', async () => {
    readFileMock.mockResolvedValue('[click](javascript:alert(1))');
    const out = await renderAgentPlan('/wt', 'docs/plans', 'evil.md');
    expect(out!.html).not.toContain('javascript:');
  });
});

describe('renderAgentPlan — global source', () => {
  it('reads from ~/.claude/plans/ when source=global', async () => {
    readFileMock.mockImplementation((p: string) =>
      p === `${GLOBAL_DIR}/foo.md`
        ? Promise.resolve('# global plan')
        : Promise.reject(new Error(`unexpected readFile: ${p}`))
    );
    const out = await renderAgentPlan('/wt', '', 'foo.md', 'global');
    expect(out).not.toBeNull();
    expect(out!.name).toBe('foo.md');
    expect(out!.html).toContain('global plan');
  });

  it('rejects path traversal attempts the same way as local', async () => {
    await expect(
      renderAgentPlan('/wt', '', '../etc/passwd.md', 'global')
    ).rejects.toThrow('invalid_filename');
    await expect(renderAgentPlan('/wt', '', 'dir/file.md', 'global')).rejects.toThrow(
      'invalid_filename'
    );
  });

  it('returns null when ~/.claude/plans does not exist', async () => {
    realpathMock.mockRejectedValue(new Error('ENOENT'));
    expect(await renderAgentPlan('/wt', '', 'plan.md', 'global')).toBeNull();
  });

  it('rejects symlink escape: file resolves outside the canonical dir', async () => {
    realpathMock.mockImplementation((p: string) => {
      if (p === GLOBAL_DIR) return Promise.resolve(GLOBAL_DIR);
      // The candidate file path realpath()s OUTSIDE the dir — the
      // symlink-flip TOCTOU we're defending against.
      if (p === `${GLOBAL_DIR}/escape.md`) return Promise.resolve('/etc/passwd');
      return Promise.reject(new Error(`unexpected realpath: ${p}`));
    });
    await expect(renderAgentPlan('/wt', '', 'escape.md', 'global')).rejects.toThrow(
      'invalid_filename'
    );
  });
});
