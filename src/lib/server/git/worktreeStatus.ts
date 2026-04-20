import { execa } from 'execa';

export interface WorktreeDirtyCheck {
  dirty: boolean;
  files: string[];
}

/**
 * Report whether a git worktree has uncommitted changes (staged, unstaged, or
 * untracked). Paths are returned as git reported them, without status codes.
 *
 * Missing directories or non-git paths are treated as clean — the caller will
 * have already decided the worktree row is stale and safe to remove.
 */
export async function isWorktreeDirty(worktreePath: string): Promise<WorktreeDirtyCheck> {
  try {
    const { stdout } = await execa('git', [
      '-C',
      worktreePath,
      'status',
      '--porcelain',
      '-z'
    ]);
    if (!stdout) return { dirty: false, files: [] };
    const files = stdout
      .split('\0')
      .filter((r) => r.length > 0)
      .map((r) => r.slice(3));
    return { dirty: files.length > 0, files };
  } catch {
    return { dirty: false, files: [] };
  }
}
