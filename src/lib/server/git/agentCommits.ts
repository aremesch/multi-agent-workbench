import { execa } from 'execa';
import type { AgentCommit } from '$lib/shared/types';

// hash \x1f parents \x1f author-name \x1f author-email \x1f committer-name
// \x1f committer-email \x1f author-date-epoch \x1f committer-date-epoch
// \x1f author-date-iso \x1f subject \x1f body \x1e
const FMT = '%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%at%x1f%ct%x1f%aI%x1f%s%x1f%b%x1e';

function parseLog(stdout: string): AgentCommit[] {
  if (!stdout.trim()) return [];
  return stdout
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.length > 0)
    .map((record) => {
      const fields = record.split('\x1f');
      const [
        sha = '',
        parents = '',
        authorName = '',
        authorEmail = '',
        committerName = '',
        committerEmail = '',
        authoredAtStr = '0',
        committedAtStr = '0',
        date = '',
        subject = '',
        body = ''
      ] = fields;
      return {
        sha,
        shortSha: sha.slice(0, 7),
        parentShas: parents.trim() ? parents.trim().split(' ') : [],
        author: authorEmail ? `${authorName} <${authorEmail}>` : authorName,
        authorName,
        authorEmail,
        committerName,
        committerEmail,
        authoredAt: Number(authoredAtStr) || 0,
        committedAt: Number(committedAtStr) || 0,
        date,
        subject,
        body: body.trimEnd(),
        reachable: true
      };
    });
}

/** Resolve a revspec to a full SHA. Returns null on failure. */
export async function resolveSha(repoPath: string, rev: string): Promise<string | null> {
  try {
    const { stdout } = await execa('git', [
      '-C',
      repoPath,
      'rev-parse',
      '--verify',
      `${rev}^{commit}`
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Primary attribution query: commits whose committer matches the agent's
 * per-agent email, optionally scoped to the <baseSha..branch> range so we
 * don't pick up unrelated commits from elsewhere in the repo's history.
 *
 * Uses a regex anchored to the start of the email field to avoid prefix
 * collisions between agent IDs; the `--fixed-strings` alternative would
 * match substrings, which is wrong when two agent emails share a prefix.
 */
export async function listCommitsByCommitter(
  repoPath: string,
  committerEmail: string,
  baseSha: string | null,
  branch: string | null
): Promise<AgentCommit[]> {
  const args = ['-C', repoPath, 'log', `--pretty=format:${FMT}`, '--no-merges'];
  args.push(`--committer=^<?${escapeRegex(committerEmail)}>?$`);

  if (baseSha && branch) {
    const branchExists = await refExists(repoPath, `refs/heads/${branch}`);
    if (branchExists) {
      args.push(`${baseSha}..${branch}`);
    } else {
      args.push('--all');
    }
  } else if (branch) {
    const branchExists = await refExists(repoPath, `refs/heads/${branch}`);
    if (branchExists) args.push(branch);
    else args.push('--all');
  } else {
    args.push('--all');
  }

  try {
    const { stdout } = await execa('git', args);
    return parseLog(stdout);
  } catch {
    return [];
  }
}

/**
 * Fallback: list all commits in `<baseSha>..<branch>` with no committer
 * filter. Used when the committer query returns nothing (e.g. an adapter
 * stripped GIT_COMMITTER_*), so we at least capture what's in the range.
 */
export async function listCommitsInRange(
  repoPath: string,
  baseSha: string,
  branch: string
): Promise<AgentCommit[]> {
  if (!(await refExists(repoPath, `refs/heads/${branch}`))) return [];
  try {
    const { stdout } = await execa('git', [
      '-C',
      repoPath,
      'log',
      `--pretty=format:${FMT}`,
      '--no-merges',
      `${baseSha}..${branch}`
    ]);
    return parseLog(stdout);
  } catch {
    return [];
  }
}

/**
 * Legacy merge-base heuristic. Retained only for one-shot back-fill of
 * agents that predate this migration (no base_sha, no committer_email).
 *
 * @deprecated Use listCommitsByCommitter / listCommitsInRange for new code.
 */
export async function listAgentCommitsViaMergeBase(
  repoPath: string,
  branch: string,
  defaultBranch: string
): Promise<AgentCommit[]> {
  if (!(await refExists(repoPath, `refs/heads/${branch}`))) return [];

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

  try {
    const { stdout } = await execa('git', [
      '-C',
      repoPath,
      'log',
      `--pretty=format:${FMT}`,
      '--no-merges',
      range
    ]);
    return parseLog(stdout);
  } catch {
    return [];
  }
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await execa('git', ['-C', repoPath, 'rev-parse', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

/** True when `ref` resolves. Thin wrapper over git rev-parse --verify. */
export async function revParseQuiet(repoPath: string, ref: string): Promise<boolean> {
  return refExists(repoPath, ref);
}

/** True when the object `sha` exists in the repo's object DB. */
export async function catFileExists(repoPath: string, sha: string): Promise<boolean> {
  try {
    await execa('git', ['-C', repoPath, 'cat-file', '-e', sha]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Batch-check which of `shas` are reachable in the repo's object DB.
 * Runs a single `git cat-file --batch-check` feeding SHAs on stdin;
 * returns the subset that resolved.
 */
export async function checkShaReachability(
  repoPath: string,
  shas: string[]
): Promise<Set<string>> {
  const unique = [...new Set(shas.filter((s) => s))];
  if (unique.length === 0) return new Set();
  try {
    const { stdout } = await execa(
      'git',
      ['-C', repoPath, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
      { input: unique.join('\n') + '\n' }
    );
    const reachable = new Set<string>();
    const lines = stdout.split('\n');
    for (let i = 0; i < lines.length && i < unique.length; i++) {
      const line = lines[i] ?? '';
      // "<sha> missing" → unreachable; "<sha> commit" → present.
      if (!line.includes(' missing')) {
        reachable.add(unique[i]!);
      }
    }
    return reachable;
  } catch {
    return new Set();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
