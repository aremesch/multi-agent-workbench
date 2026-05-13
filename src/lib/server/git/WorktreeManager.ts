/**
 * Git worktree management via `simple-git`. Worktree subcommands go through
 * `.raw(['worktree', ...])` (simple-git has no first-class worktree API);
 * everything else (status, revparse, init, commit) uses the structured API.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GitIdentity } from '../user/gitIdentity.js';
import { getGit } from './client.js';

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
  detached: boolean;
}

/**
 * Git `-c` flags that pin author and committer for a single `git` invocation.
 * Used for MAW's own admin commits (empty-dir init, unborn-repo seeding) so
 * the acting user — not the `maw` Unix account the server runs as — is the
 * one recorded in the repo history.
 */
function commitIdentityFlags(identity: GitIdentity): string[] {
  return [
    '-c',
    `user.name=${identity.name}`,
    '-c',
    `user.email=${identity.email}`
  ];
}

export class WorktreeManager {
  constructor(private readonly worktreeRoot: string) {}

  /** `git worktree list --porcelain` parsed into structured entries. */
  static async list(repoPath: string): Promise<WorktreeEntry[]> {
    const stdout = await getGit(repoPath).raw(['worktree', 'list', '--porcelain']);
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
   *
   * Also resolves `startPoint` to its full SHA so callers can record the
   * exact commit the agent was anchored to (the `base_sha` used by the
   * commit attribution layer). Unresolved SHAs fall through as null.
   */
  async create(opts: {
    repoPath: string;
    agentId: string;
    branch: string;
    startPoint?: string; // defaults to HEAD
    dirName?: string;
  }): Promise<{ path: string; baseSha: string | null }> {
    const wtPath = join(this.worktreeRoot, opts.dirName ?? opts.agentId);
    if (existsSync(wtPath)) {
      throw new Error(`worktree path already exists: ${wtPath}`);
    }
    const start = opts.startPoint ?? 'HEAD';
    const git = getGit(opts.repoPath);
    await git.raw(['worktree', 'add', '-B', opts.branch, wtPath, start]);
    let baseSha: string | null = null;
    try {
      const stdout = await git.revparse(['--verify', `${start}^{commit}`]);
      baseSha = stdout.trim() || null;
    } catch {
      baseSha = null;
    }
    return { path: wtPath, baseSha };
  }

  /**
   * Remove a worktree. `git worktree remove` refuses dirty trees — the caller
   * can pass `force: true` when they've confirmed loss is acceptable (this is
   * policy deferred until v0.2 per plan §Open risks #7).
   */
  async remove(opts: { repoPath: string; wtPath: string; force?: boolean }): Promise<void> {
    const args = ['worktree', 'remove'];
    if (opts.force) args.push('--force');
    args.push(opts.wtPath);
    await getGit(opts.repoPath).raw(args);
  }

  /** `git worktree prune` — cleans up stale admin files after manual dir removal. */
  static async prune(repoPath: string): Promise<void> {
    await getGit(repoPath).raw(['worktree', 'prune']);
  }

  /** Dirty check: `true` if the worktree has uncommitted changes. */
  static async isDirty(wtPath: string): Promise<boolean> {
    try {
      const result = await getGit(wtPath).status();
      return result.files.length > 0;
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
   * `identity` is the author/committer for the seed commit — caller passes
   * the logged-in user's resolved git identity.
   */
  static async initEmpty(dir: string, desired: string, identity: GitIdentity): Promise<void> {
    const git = getGit(dir);
    await git.raw(['init', '-b', desired]);
    await git.raw([
      ...commitIdentityFlags(identity),
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
    desired: string,
    identity: GitIdentity
  ): Promise<
    | { kind: 'exists' }
    | { kind: 'renamed'; from: 'master' }
    | { kind: 'seeded' }
    | { kind: 'no_master'; current: string | null }
  > {
    const git = getGit(repoPath);
    const gitExits = async (args: string[]): Promise<boolean> => {
      try {
        await git.raw(args);
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
      await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${desired}`]);
      await git.raw([
        ...commitIdentityFlags(identity),
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
      await git.raw(['branch', '-m', 'master', desired]);
      return { kind: 'renamed', from: 'master' };
    }

    // 4. Neither desired nor master exists, but HEAD resolves: detached HEAD,
    //    or a non-main/non-master branch is the only one. Report the current
    //    branch so the caller can craft a useful error message.
    let current: string | null = null;
    try {
      const stdout = await git.raw(['symbolic-ref', '--short', 'HEAD']);
      current = stdout.trim() || null;
    } catch {
      current = null;
    }
    return { kind: 'no_master', current };
  }
}
