/**
 * Git worktree management via `execa`. Per plan, we shell out rather than
 * using a git library because worktree/dirty-state/edge cases are easier to
 * debug at the CLI level.
 */

import { execa } from 'execa';
import { join } from 'node:path';

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
  detached: boolean;
}

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
   * Create a new worktree at <worktreeRoot>/<agentId>, checking out or
   * creating `branch`. Uses `git worktree add -B <branch> <path> <startPoint>`
   * which is idempotent on branch creation (-B overwrites).
   */
  async create(opts: {
    repoPath: string;
    agentId: string;
    branch: string;
    startPoint?: string; // defaults to HEAD
  }): Promise<string> {
    const wtPath = join(this.worktreeRoot, opts.agentId);
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
}
