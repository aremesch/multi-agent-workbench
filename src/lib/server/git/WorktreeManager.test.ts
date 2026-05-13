import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimpleGit } from 'simple-git';

const rawMock = vi.fn();
const statusMock = vi.fn();
const revparseMock = vi.fn();
const getGitMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock('$lib/server/git/client', () => ({
  getGit: (cwd?: string) => getGitMock(cwd)
}));

vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...real, existsSync: (p: string) => existsSyncMock(p) };
});

import { WorktreeManager } from './WorktreeManager.js';

beforeEach(() => {
  rawMock.mockReset();
  statusMock.mockReset();
  revparseMock.mockReset();
  getGitMock.mockReset();
  getGitMock.mockReturnValue({
    raw: rawMock,
    status: statusMock,
    revparse: revparseMock
  } as unknown as SimpleGit);
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
});

function routeRaw(
  routes: Array<{ match: (args: string[]) => boolean; result: { stdout?: string; throws?: boolean } }>
): void {
  rawMock.mockImplementation((args: string[]) => {
    const r = routes.find((route) => route.match(args));
    if (!r) {
      throw new Error(`unmatched: ${args.join(' ')}`);
    }
    if (r.result.throws) {
      throw new Error('git fail');
    }
    return Promise.resolve(r.result.stdout ?? '');
  });
}

// -----------------------------------------------------------------------------
// list()
// -----------------------------------------------------------------------------

describe('WorktreeManager.list', () => {
  it('parses the --porcelain block format into structured entries', async () => {
    const porcelain = [
      'worktree /repo/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/feature',
      'HEAD def456',
      'branch refs/heads/feature',
      '',
      'worktree /repo/bare',
      'bare',
      '',
      'worktree /repo/detach',
      'HEAD 00',
      'detached'
    ].join('\n');
    rawMock.mockResolvedValueOnce(porcelain);
    const out = await WorktreeManager.list('/repo');
    expect(out).toEqual([
      { path: '/repo/main', branch: 'main', head: 'abc123', bare: false, detached: false },
      { path: '/repo/feature', branch: 'feature', head: 'def456', bare: false, detached: false },
      { path: '/repo/bare', branch: null, head: null, bare: true, detached: false },
      { path: '/repo/detach', branch: null, head: '00', bare: false, detached: true }
    ]);
    expect(getGitMock).toHaveBeenCalledWith('/repo');
    expect(rawMock.mock.calls[0]![0]).toEqual(['worktree', 'list', '--porcelain']);
  });

  it('returns [] for empty porcelain output', async () => {
    rawMock.mockResolvedValueOnce('');
    expect(await WorktreeManager.list('/repo')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// create()
// -----------------------------------------------------------------------------

describe('WorktreeManager.create', () => {
  it('builds the expected `worktree add -B <branch> <path> <start>` argv', async () => {
    existsSyncMock.mockReturnValue(false);
    rawMock.mockResolvedValueOnce('');
    revparseMock.mockResolvedValueOnce('sha');
    const wm = new WorktreeManager('/wts');
    const { path } = await wm.create({
      repoPath: '/repo',
      agentId: '01ABC',
      branch: 'maw/01ABC',
      dirName: 'my-task'
    });
    expect(path).toBe('/wts/my-task');
    expect(getGitMock).toHaveBeenCalledWith('/repo');
    expect(rawMock.mock.calls[0]![0]).toEqual([
      'worktree',
      'add',
      '-B',
      'maw/01ABC',
      '/wts/my-task',
      'HEAD'
    ]);
  });

  it('falls back to agentId as dirname when dirName is omitted', async () => {
    existsSyncMock.mockReturnValue(false);
    rawMock.mockResolvedValueOnce('');
    revparseMock.mockResolvedValueOnce('sha');
    const wm = new WorktreeManager('/wts');
    await wm.create({ repoPath: '/r', agentId: '01XYZ', branch: 'b' });
    expect(rawMock.mock.calls[0]![0][4]).toBe('/wts/01XYZ');
  });

  it('respects an explicit startPoint', async () => {
    existsSyncMock.mockReturnValue(false);
    rawMock.mockResolvedValueOnce('');
    revparseMock.mockResolvedValueOnce('sha');
    const wm = new WorktreeManager('/wts');
    await wm.create({ repoPath: '/r', agentId: 'a', branch: 'b', startPoint: 'origin/main' });
    const args = rawMock.mock.calls[0]![0];
    expect(args[args.length - 1]).toBe('origin/main');
  });

  it('throws if the target path already exists on disk', async () => {
    existsSyncMock.mockReturnValue(true);
    const wm = new WorktreeManager('/wts');
    await expect(wm.create({ repoPath: '/r', agentId: 'a', branch: 'b' })).rejects.toThrow(
      /already exists/
    );
    expect(rawMock).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// remove()
// -----------------------------------------------------------------------------

describe('WorktreeManager.remove', () => {
  it('invokes `worktree remove` without --force by default', async () => {
    rawMock.mockResolvedValueOnce('');
    const wm = new WorktreeManager('/wts');
    await wm.remove({ repoPath: '/r', wtPath: '/wts/x' });
    expect(getGitMock).toHaveBeenCalledWith('/r');
    expect(rawMock.mock.calls[0]![0]).toEqual(['worktree', 'remove', '/wts/x']);
  });

  it('threads `--force` when requested', async () => {
    rawMock.mockResolvedValueOnce('');
    const wm = new WorktreeManager('/wts');
    await wm.remove({ repoPath: '/r', wtPath: '/wts/x', force: true });
    const args = rawMock.mock.calls[0]![0];
    expect(args).toContain('--force');
    expect(args[args.length - 1]).toBe('/wts/x');
  });
});

// -----------------------------------------------------------------------------
// prune() + isDirty()
// -----------------------------------------------------------------------------

describe('WorktreeManager.prune', () => {
  it('shells out to `worktree prune`', async () => {
    rawMock.mockResolvedValueOnce('');
    await WorktreeManager.prune('/r');
    expect(getGitMock).toHaveBeenCalledWith('/r');
    expect(rawMock.mock.calls[0]![0]).toEqual(['worktree', 'prune']);
  });
});

describe('WorktreeManager.isDirty', () => {
  it('returns true when status reports any files', async () => {
    statusMock.mockResolvedValueOnce({ files: [{ path: 'file.ts', index: ' ', working_dir: 'M' }] });
    expect(await WorktreeManager.isDirty('/w')).toBe(true);
  });

  it('returns false when status reports no files', async () => {
    statusMock.mockResolvedValueOnce({ files: [] });
    expect(await WorktreeManager.isDirty('/w')).toBe(false);
  });

  it('returns false when git errors (conservative — treat as clean)', async () => {
    statusMock.mockRejectedValueOnce(new Error('oops'));
    expect(await WorktreeManager.isDirty('/w')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// initEmpty()
// -----------------------------------------------------------------------------

describe('WorktreeManager.initEmpty', () => {
  it('runs git init -b <desired> then an empty initial commit with the given identity', async () => {
    rawMock.mockResolvedValue('');
    await WorktreeManager.initEmpty('/dir', 'main', { name: 'Alice', email: 'a@b.c' });
    expect(getGitMock).toHaveBeenCalledWith('/dir');
    expect(rawMock.mock.calls[0]![0]).toEqual(['init', '-b', 'main']);
    const commitArgs = rawMock.mock.calls[1]![0];
    expect(commitArgs).toContain('user.name=Alice');
    expect(commitArgs).toContain('user.email=a@b.c');
    expect(commitArgs).toContain('commit');
    expect(commitArgs).toContain('--allow-empty');
    expect(commitArgs[commitArgs.length - 1]).toBe('initial commit');
  });
});

// -----------------------------------------------------------------------------
// ensureDefaultBranch() — self-heal state machine
// -----------------------------------------------------------------------------

describe('WorktreeManager.ensureDefaultBranch', () => {
  it('returns { kind: "exists" } when the desired branch is already there', async () => {
    routeRaw([
      {
        match: (a) => a.includes('rev-parse') && a.includes('refs/heads/main'),
        result: { stdout: 'sha' }
      }
    ]);
    const out = await WorktreeManager.ensureDefaultBranch('/r', 'main', { name: 'Alice', email: 'a@b.c' });
    expect(out).toEqual({ kind: 'exists' });
  });

  it('seeds an unborn repo (no desired, no HEAD) via symbolic-ref + empty commit', async () => {
    routeRaw([
      {
        match: (a) => a.includes('rev-parse') && a.includes('refs/heads/main'),
        result: { throws: true }
      },
      {
        match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'HEAD',
        result: { throws: true } // HEAD doesn't resolve → unborn
      },
      {
        match: (a) => a.includes('symbolic-ref') && !a.includes('--short'),
        result: { stdout: '' }
      },
      {
        match: (a) => a.includes('commit'),
        result: { stdout: '' }
      }
    ]);
    const out = await WorktreeManager.ensureDefaultBranch('/r', 'main', { name: 'Alice', email: 'a@b.c' });
    expect(out).toEqual({ kind: 'seeded' });
  });

  it('renames legacy `master` to the desired branch', async () => {
    let headSeen = false;
    rawMock.mockImplementation((args: string[]) => {
      if (args.includes('rev-parse') && args.includes('refs/heads/main')) {
        throw new Error('');
      }
      if (!headSeen && args.includes('rev-parse') && args[args.length - 1] === 'HEAD') {
        headSeen = true;
        return Promise.resolve('sha'); // repo has commits
      }
      if (args.includes('rev-parse') && args.includes('refs/heads/master')) {
        return Promise.resolve('sha');
      }
      if (args.includes('branch') && args.includes('-m')) {
        return Promise.resolve('');
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const out = await WorktreeManager.ensureDefaultBranch('/r', 'main', { name: 'Alice', email: 'a@b.c' });
    expect(out).toEqual({ kind: 'renamed', from: 'master' });
    // Rename call was the final one.
    const last = rawMock.mock.calls.at(-1)?.[0];
    expect(last).toEqual(['branch', '-m', 'master', 'main']);
  });

  it('returns no_master with the current branch when only a non-master primary exists', async () => {
    rawMock.mockImplementation((args: string[]) => {
      // Check symbolic-ref --short FIRST — its final arg is also HEAD.
      if (args.includes('symbolic-ref') && args.includes('--short')) {
        return Promise.resolve('develop\n');
      }
      if (args.includes('rev-parse') && args.includes('refs/heads/main')) {
        throw new Error('');
      }
      if (args.includes('rev-parse') && args.includes('refs/heads/master')) {
        throw new Error('');
      }
      if (args.includes('rev-parse') && args[args.length - 1] === 'HEAD') {
        return Promise.resolve('sha'); // repo has commits
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const out = await WorktreeManager.ensureDefaultBranch('/r', 'main', { name: 'Alice', email: 'a@b.c' });
    expect(out).toEqual({ kind: 'no_master', current: 'develop' });
  });

  it('returns no_master with current=null on detached HEAD', async () => {
    rawMock.mockImplementation((args: string[]) => {
      if (args.includes('symbolic-ref') && args.includes('--short')) {
        throw new Error('detached HEAD');
      }
      if (args.includes('rev-parse') && args.includes('refs/heads/main')) {
        throw new Error('');
      }
      if (args.includes('rev-parse') && args.includes('refs/heads/master')) {
        throw new Error('');
      }
      if (args.includes('rev-parse') && args[args.length - 1] === 'HEAD') {
        return Promise.resolve('sha');
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const out = await WorktreeManager.ensureDefaultBranch('/r', 'main', { name: 'Alice', email: 'a@b.c' });
    expect(out).toEqual({ kind: 'no_master', current: null });
  });
});
