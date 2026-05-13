import { getGit } from './client';

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
    const result = await getGit(worktreePath).status();
    const files = result.files.map((f) => f.path);
    return { dirty: files.length > 0, files };
  } catch {
    return { dirty: false, files: [] };
  }
}
