import { beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock('execa', () => ({
  execa: (cmd: string, args: string[]) => execaMock(cmd, args)
}));

vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...real, existsSync: (p: string) => existsSyncMock(p) };
});

import { WorktreeManager } from './WorktreeManager.js';

beforeEach(() => {
  execaMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
});

function routeExeca(
  routes: Array<{ match: (args: string[]) => boolean; result: { stdout?: string; stderr?: string; throws?: boolean } }>
): void {
  execaMock.mockImplementation((_cmd: string, args: string[]) => {
    const r = routes.find((route) => route.match(args));
    if (!r) {
      throw Object.assign(new Error(`unmatched: ${args.join(' ')}`), { stderr: '' });
    }
    if (r.result.throws) {
      throw Object.assign(new Error('git fail'), { stderr: r.result.stderr ?? '' });
    }
    return Promise.resolve({ stdout: r.result.stdout ?? '', stderr: '' });
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
    execaMock.mockResolvedValueOnce({ stdout: porcelain });
    const out = await WorktreeManager.list('/repo');
    expect(out).toEqual([
      { path: '/repo/main', branch: 'main', head: 'abc123', bare: false, detached: false },
      { path: '/repo/feature', branch: 'feature', head: 'def456', bare: false, detached: false },
      { path: '/repo/bare', branch: null, head: null, bare: true, detached: false },
      { path: '/repo/detach', branch: null, head: '00', bare: false, detached: true }
    ]);
  });

  it('returns [] for empty porcelain output', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    expect(await WorktreeManager.list('/repo')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// create()
// -----------------------------------------------------------------------------

describe('WorktreeManager.create', () => {
  it('builds the expected `worktree add -B <branch> <path> <start>` argv', async () => {
    existsSyncMock.mockReturnValue(false);
    execaMock.mockResolvedValueOnce({ stdout: '' });
    const wm = new WorktreeManager('/wts');
    const { path } = await wm.create({
      repoPath: '/repo',
      agentId: '01ABC',
      branch: 'maw/01ABC',
      dirName: 'my-task'
    });
    expect(path).toBe('/wts/my-task');
    const args = execaMock.mock.calls[0][1];
    expect(args).toEqual([
      '-C',
      '/repo',
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
    execaMock.mockResolvedValueOnce({ stdout: '' });
    const wm = new WorktreeManager('/wts');
    await wm.create({ repoPath: '/r', agentId: '01XYZ', branch: 'b' });
    expect(execaMock.mock.calls[0][1][6]).toBe('/wts/01XYZ');
  });

  it('respects an explicit startPoint', async () => {
    existsSyncMock.mockReturnValue(false);
    execaMock.mockResolvedValueOnce({ stdout: '' });
    const wm = new WorktreeManager('/wts');
    await wm.create({ repoPath: '/r', agentId: 'a', branch: 'b', startPoint: 'origin/main' });
    const args = execaMock.mock.calls[0][1];
    expect(args[args.length - 1]).toBe('origin/main');
  });

  it('throws if the target path already exists on disk', async () => {
    existsSyncMock.mockReturnValue(true);
    const wm = new WorktreeManager('/wts');
    await expect(wm.create({ repoPath: '/r', agentId: 'a', branch: 'b' })).rejects.toThrow(
      /already exists/
    );
    expect(execaMock).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// remove()
// -----------------------------------------------------------------------------

describe('WorktreeManager.remove', () => {
  it('invokes `worktree remove` without --force by default', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    const wm = new WorktreeManager('/wts');
    await wm.remove({ repoPath: '/r', wtPath: '/wts/x' });
    const args = execaMock.mock.calls[0][1];
    expect(args).toEqual(['-C', '/r', 'worktree', 'remove', '/wts/x']);
  });

  it('threads `--force` when requested', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    const wm = new WorktreeManager('/wts');
    await wm.remove({ repoPath: '/r', wtPath: '/wts/x', force: true });
    const args = execaMock.mock.calls[0][1];
    expect(args).toContain('--force');
    expect(args[args.length - 1]).toBe('/wts/x');
  });
});

// -----------------------------------------------------------------------------
// prune() + isDirty()
// -----------------------------------------------------------------------------

describe('WorktreeManager.prune', () => {
  it('shells out to `worktree prune`', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    await WorktreeManager.prune('/r');
    expect(execaMock.mock.calls[0][1]).toEqual(['-C', '/r', 'worktree', 'prune']);
  });
});

describe('WorktreeManager.isDirty', () => {
  it('returns true when `status --porcelain` has any output', async () => {
    execaMock.mockResolvedValueOnce({ stdout: ' M file.ts' });
    expect(await WorktreeManager.isDirty('/w')).toBe(true);
  });

  it('returns false on empty output', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    expect(await WorktreeManager.isDirty('/w')).toBe(false);
  });

  it('returns false when git errors (conservative — treat as clean)', async () => {
    execaMock.mockRejectedValueOnce(new Error('oops'));
    expect(await WorktreeManager.isDirty('/w')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// initEmpty()
// -----------------------------------------------------------------------------

describe('WorktreeManager.initEmpty', () => {
  it('runs git init -b <desired> then an empty initial commit with the MAW identity', async () => {
    execaMock.mockResolvedValue({ stdout: '' });
    await WorktreeManager.initEmpty('/dir', 'main');
    expect(execaMock.mock.calls[0][1]).toEqual(['-C', '/dir', 'init', '-b', 'main']);
    const commitArgs = execaMock.mock.calls[1][1];
    // -c user.name= ... -c user.email= ... -C /dir commit --allow-empty -m "initial commit"
    expect(commitArgs).toContain('user.name=Multi-Agent Workbench');
    expect(commitArgs).toContain('user.email=maw@localhost');
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
    routeExeca([
      {
        match: (a) => a.includes('rev-parse') && a.includes('refs/heads/main'),
        result: { stdout: 'sha' }
      }
    ]);
    const out = await WorktreeManager.ensureDefaultBranch('/r', 'main');
    expect(out).toEqual({ kind: 'exists' });
  });

  it('seeds an unborn repo (no desired, no HEAD) via symbolic-ref + empty commit', async () => {
    routeExeca([
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
    const out = await WorktreeManager.ensureDefaultBranch('/r', 'main');
    expect(out).toEqual({ kind: 'seeded' });
  });

  it('renames legacy `master` to the desired branch', async () => {
    let headSeen = false;
    execaMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('rev-parse') && args.includes('refs/heads/main')) {
        throw Object.assign(new Error(''), { stderr: '' });
      }
      if (!headSeen && args.includes('rev-parse') && args[args.length - 1] === 'HEAD') {
        headSeen = true;
        return Promise.resolve({ stdout: 'sha' }); // repo has commits
      }
      if (args.includes('rev-parse') && args.includes('refs/heads/master')) {
        return Promise.resolve({ stdout: 'sha' });
      }
      if (args.includes('branch') && args.includes('-m')) {
        return Promise.resolve({ stdout: '' });
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const out = await WorktreeManager.ensureDefaultBranch('/r', 'main');
    expect(out).toEqual({ kind: 'renamed', from: 'master' });
    // Rename call was the final one.
    const last = execaMock.mock.calls.at(-1)?.[1];
    expect(last).toEqual(['-C', '/r', 'branch', '-m', 'master', 'main']);
  });

  it('returns no_master with the current branch when only a non-master primary exists', async () => {
    execaMock.mockImplementation((_cmd: string, args: string[]) => {
      // Check symbolic-ref --short FIRST — its final arg is also HEAD.
      if (args.includes('symbolic-ref') && args.includes('--short')) {
        return Promise.resolve({ stdout: 'develop\n' });
      }
      if (args.includes('rev-parse') && args.includes('refs/heads/main')) {
        throw Object.assign(new Error(''), { stderr: '' });
      }
      if (args.includes('rev-parse') && args.includes('refs/heads/master')) {
        throw Object.assign(new Error(''), { stderr: '' });
      }
      if (args.includes('rev-parse') && args[args.length - 1] === 'HEAD') {
        return Promise.resolve({ stdout: 'sha' }); // repo has commits
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const out = await WorktreeManager.ensureDefaultBranch('/r', 'main');
    expect(out).toEqual({ kind: 'no_master', current: 'develop' });
  });

  it('returns no_master with current=null on detached HEAD', async () => {
    execaMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('symbolic-ref') && args.includes('--short')) {
        throw Object.assign(new Error(''), { stderr: 'detached HEAD' });
      }
      if (args.includes('rev-parse') && args.includes('refs/heads/main')) {
        throw Object.assign(new Error(''), { stderr: '' });
      }
      if (args.includes('rev-parse') && args.includes('refs/heads/master')) {
        throw Object.assign(new Error(''), { stderr: '' });
      }
      if (args.includes('rev-parse') && args[args.length - 1] === 'HEAD') {
        return Promise.resolve({ stdout: 'sha' });
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const out = await WorktreeManager.ensureDefaultBranch('/r', 'main');
    expect(out).toEqual({ kind: 'no_master', current: null });
  });
});
