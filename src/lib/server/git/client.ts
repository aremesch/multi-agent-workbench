import simpleGit, { type SimpleGit, type SimpleGitOptions } from 'simple-git';

export function getGit(cwd?: string, overrides?: Partial<SimpleGitOptions>): SimpleGit {
  return simpleGit({
    baseDir: cwd,
    binary: 'git',
    maxConcurrentProcesses: 6,
    ...overrides
  });
}

export { GitError, GitResponseError } from 'simple-git';
export type { SimpleGit, SimpleGitOptions } from 'simple-git';
