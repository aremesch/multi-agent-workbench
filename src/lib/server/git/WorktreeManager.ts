/**
 * Git worktree management via `execa`. Per plan, we shell out rather than
 * using a git library because worktree/dirty-state/edge cases are easier to
 * debug at the CLI level.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
  detached: boolean;
}

/**
 * Git config flags used whenever MAW creates commits on the user's behalf
 * (empty-dir init, unborn-repo seeding). Passed via `-c` so we never touch
 * the repo's own config file.
 */
const MAW_COMMIT_IDENTITY = [
  '-c',
  'user.name=Multi-Agent Workbench',
  '-c',
  'user.email=maw@localhost'
];

export class WorktreeManager {
  constructor(private readonly worktreeRoot: string) {}

  /** `git worktree list --porcelain` parsed into structured entries. */
  static async list(repoPath: string): Promise<WorktreeEntry[]> {
    const { stdout } = await execa('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
    const blocks = stdout.split('\n\n').filter((b) => b.trim());
    return blocks.map((block) => {
      const entry: WorktreeEntry = { path: '', branch: null, head: null, bare: false, detached: false };
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) entry.path = line.slice(9);
        else if (line.startsWith('HEAD ')) entry.head = line.slice(5);
        else if (line.startsWith('branch ')) entry.branch = line.slice(7).replace(/^refs\/heads\//, '');
        else if (line === 'bare') entry.bare = true;
        else if (line === 'detached') entry.detached = true;
      }
      return entry;
    });
  }

  /**
   * Create a new worktree at <worktreeRoot>/<dirName ?? agentId>, checking out
   * or creating `branch`. Uses `git worktree add -B <branch> <path> <startPoint>`
   * which is idempotent on branch creation (-B overwrites).
   *
   * `dirName` is used when the caller has a human-readable slug (e.g. the
   * agent's task title) so the worktree directory is discoverable on disk.
   * It must already be filesystem-safe — the caller is responsible for
   * slugifying. Throws if the resolved path already exists.
   */
  async create(opts: {
    repoPath: string;
    agentId: string;
    branch: string;
    startPoint?: string; // defaults to HEAD
    dirName?: string;
  }): Promise<string> {
    const wtPath = join(this.worktreeRoot, opts.dirName ?? opts.agentId);
    if (existsSync(wtPath)) {
      throw new Error(`worktree path already exists: ${wtPath}`);
    }
    const start = opts.startPoint ?? 'HEAD';
    await execa('git', [
      '-C',
      opts.repoPath,
      'worktree',
      'add',
      '-B',
      opts.branch,
      wtPath,
      start
    ]);
    return wtPath;
  }

  /**
   * Remove a worktree. `git worktree remove` refuses dirty trees — the caller
   * can pass `force: true` when they've confirmed loss is acceptable (this is
   * policy deferred until v0.2 per plan §Open risks #7).
   */
  async remove(opts: { repoPath: string; wtPath: string; force?: boolean }): Promise<void> {
    const args = ['-C', opts.repoPath, 'worktree', 'remove'];
    if (opts.force) args.push('--force');
    args.push(opts.wtPath);
    await execa('git', args);
  }

  /** `git worktree prune` — cleans up stale admin files after manual dir removal. */
  static async prune(repoPath: string): Promise<void> {
    await execa('git', ['-C', repoPath, 'worktree', 'prune']);
  }

  /** Dirty check: `true` if the worktree has uncommitted changes. */
  static async isDirty(wtPath: string): Promise<boolean> {
    try {
      const { stdout } = await execa('git', ['-C', wtPath, 'status', '--porcelain']);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Initialize a brand-new git repo in an empty directory.
   *
   * Runs `git init -b <desired>` followed by an empty initial commit on that
   * branch. Used by the repo-attach action when the user points MAW at an
   * empty directory — MAW sets it up the way it wants (matching the project's
   * default branch) so downstream worktree operations just work.
   *
   * The caller must verify the directory is empty; this helper does not check.
   */
  static async initEmpty(dir: string, desired: string): Promise<void> {
    await execa('git', ['-C', dir, 'init', '-b', desired]);
    await execa('git', [
      ...MAW_COMMIT_IDENTITY,
      '-C',
      dir,
      'commit',
      '--allow-empty',
      '-m',
      'initial commit'
    ]);
  }

  /**
   * Normalize the default branch of an existing git repo so MAW can use it.
   *
   * MAW projects prefer `main`. Incoming repos may be in one of several
   * states; this helper brings them to the point where `<desired>` exists
   * as a branch with at least one commit behind it, without touching any
   * remote refs or existing content beyond what the user implicitly approved
   * by clicking "New repo". Cases:
   *
   * - `exists`: `<desired>` already exists → no-op.
   * - `renamed`: desired missing, `master` exists with commits → local rename
   *   `master` → `<desired>`. Touches nothing on origin.
   * - `seeded`: repo is unborn (HEAD points at an as-yet-nonexistent branch,
   *   no commits anywhere) → point HEAD at `refs/heads/<desired>` and create
   *   an empty initial commit. Brings the repo into a usable state.
   * - `no_master`: repo has commits and a real branch that is neither the
   *   desired one nor `master` (detached HEAD, or an intentional `develop`
   *   primary branch). MAW refuses to touch it; caller surfaces the error.
   *
   * Intentionally conservative: we never rename an arbitrary branch to
   * `<desired>`, only `master`. Repos with a deliberate non-main primary
   * branch are left alone.
   */
  static async ensureDefaultBranch(
    repoPath: string,
    desired: string
  ): Promise<
    | { kind: 'exists' }
    | { kind: 'renamed'; from: 'master' }
    | { kind: 'seeded' }
    | { kind: 'no_master'; current: string | null }
  > {
    const gitExits = async (args: string[]): Promise<boolean> => {
      try {
        await execa('git', ['-C', repoPath, ...args]);
        return true;
      } catch {
        return false;
      }
    };

    // 1. Does the desired branch already exist?
    if (await gitExits(['rev-parse', '--verify', `refs/heads/${desired}`])) {
      return { kind: 'exists' };
    }

    // 2. Does the repo have any commits at all? If not, it's unborn — we
    //    re-point HEAD at the desired branch and seed an initial empty commit.
    if (!(await gitExits(['rev-parse', '--verify', 'HEAD']))) {
      await execa('git', [
        '-C',
        repoPath,
        'symbolic-ref',
        'HEAD',
        `refs/heads/${desired}`
      ]);
      await execa('git', [
        ...MAW_COMMIT_IDENTITY,
        '-C',
        repoPath,
        'commit',
        '--allow-empty',
        '-m',
        'initial commit'
      ]);
      return { kind: 'seeded' };
    }

    // 3. Is there a legacy `master` branch we can rename into place?
    //    `git branch -m master <desired>` works even when a different branch
    //    is currently checked out.
    if (await gitExits(['rev-parse', '--verify', 'refs/heads/master'])) {
      await execa('git', ['-C', repoPath, 'branch', '-m', 'master', desired]);
      return { kind: 'renamed', from: 'master' };
    }

    // 4. Neither desired nor master exists, but HEAD resolves: detached HEAD,
    //    or a non-main/non-master branch is the only one. Report the current
    //    branch so the caller can craft a useful error message.
    let current: string | null = null;
    try {
      const { stdout } = await execa('git', [
        '-C',
        repoPath,
        'symbolic-ref',
        '--short',
        'HEAD'
      ]);
      current = stdout.trim() || null;
    } catch {
      current = null;
    }
    return { kind: 'no_master', current };
  }
}
