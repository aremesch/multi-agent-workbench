import { execa } from 'execa';
import type { AgentCommit } from '$lib/shared/types';

const FMT = '%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e';

/**
 * Return commits unique to `branch` relative to `defaultBranch`, via merge-base.
 * If the branch is missing (e.g. deleted post-archive), returns []. Any other
 * git failure bubbles up to the caller so it can distinguish empty from error.
 */
export async function listAgentCommits(
  repoPath: string,
  branch: string,
  defaultBranch: string
): Promise<AgentCommit[]> {
  // Verify branch exists first — avoids a confusing "unknown revision" error
  // in the more interesting log call.
  try {
    await execa('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${branch}`]);
  } catch {
    return [];
  }

  let range: string;
  try {
    const { stdout } = await execa('git', [
      '-C',
      repoPath,
      'merge-base',
      branch,
      defaultBranch
    ]);
    const base = stdout.trim();
    range = base ? `${base}..${branch}` : branch;
  } catch {
    range = branch;
  }

  const { stdout } = await execa('git', [
    '-C',
    repoPath,
    'log',
    `--pretty=format:${FMT}`,
    '--no-merges',
    range
  ]);

  if (!stdout.trim()) return [];

  return stdout
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.length > 0)
    .map((record) => {
      const [sha = '', author = '', date = '', subject = '', body = ''] = record.split('\x1f');
      return {
        sha,
        shortSha: sha.slice(0, 7),
        author,
        date,
        subject,
        body: body.trimEnd()
      };
    });
}
