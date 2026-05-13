import { execa } from 'execa';
import type { AgentCommit } from '$lib/shared/types';
import { getGit } from './client.js';

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
    const stdout = await getGit(repoPath).revparse(['--verify', `${rev}^{commit}`]);
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
  const args = ['log', `--pretty=format:${FMT}`, '--no-merges'];
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
    const stdout = await getGit(repoPath).raw(args);
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
    const stdout = await getGit(repoPath).raw([
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

  const git = getGit(repoPath);
  let range: string;
  try {
    const stdout = await git.raw(['merge-base', branch, defaultBranch]);
    const base = stdout.trim();
    range = base ? `${base}..${branch}` : branch;
  } catch {
    range = branch;
  }

  try {
    const stdout = await git.raw([
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
    await getGit(repoPath).revparse(['--verify', ref]);
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
    await getGit(repoPath).raw(['cat-file', '-e', sha]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine which of `shas` are reachable from the remote, i.e. the
 * upstream link `{webBase}/commit/{sha}` is expected to resolve. A SHA
 * is treated as reachable iff at least one remote-tracking ref
 * (`refs/remotes/**`) contains it. Repos with no remote refs fall back
 * to local object-DB existence so offline repos don't paint every
 * commit as stale.
 *
 * Note: reflects the local view of remote refs — if the user hasn't
 * fetched since an upstream rewrite, a stale SHA may still look
 * reachable until the next `git fetch --prune`.
 */
export async function checkShaReachability(
  repoPath: string,
  shas: string[]
): Promise<Set<string>> {
  const unique = [...new Set(shas.filter((s) => s))];
  if (unique.length === 0) return new Set();

  const git = getGit(repoPath);

  let hasRemote = false;
  try {
    const stdout = await git.raw([
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      'refs/remotes/'
    ]);
    hasRemote = stdout.trim().length > 0;
  } catch {
    hasRemote = false;
  }

  if (!hasRemote) {
    // No remote configured → fall back to local object existence so
    // pure-local repos don't paint every commit as stale. simple-git's
    // .raw() doesn't expose stdin, so we use execa for this one call.
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
        if (!line.includes(' missing')) reachable.add(unique[i]!);
      }
      return reachable;
    } catch {
      return new Set();
    }
  }

  // Check each SHA against the remote-tracking refs in parallel. A SHA
  // is reachable iff at least one ref under refs/remotes/ contains it.
  const results = await Promise.all(
    unique.map(async (sha) => {
      try {
        const stdout = await git.raw([
          'for-each-ref',
          '--count=1',
          '--format=%(refname)',
          '--contains',
          sha,
          'refs/remotes/'
        ]);
        return [sha, stdout.trim().length > 0] as const;
      } catch {
        return [sha, false] as const;
      }
    })
  );
  return new Set(results.filter(([, ok]) => ok).map(([sha]) => sha));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
