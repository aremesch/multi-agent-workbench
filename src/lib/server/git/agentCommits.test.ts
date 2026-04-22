import { beforeEach, describe, expect, it, vi } from 'vitest';

// Scripted execa mock: each test registers handlers keyed by the joined
// argv; the mock looks up the right response or calls the router fn.
const execaMock = vi.fn();
vi.mock('execa', () => ({
  execa: (cmd: string, args: string[], opts?: unknown) => execaMock(cmd, args, opts)
}));

import {
  catFileExists,
  checkShaReachability,
  listAgentCommitsViaMergeBase,
  revParseQuiet
} from './agentCommits.js';

beforeEach(() => {
  execaMock.mockReset();
});

/** Route calls by matching on `args[1..]` (strip the `-C <repo>` prefix). */
function routeExeca(
  routes: Record<string, { stdout?: string; stderr?: string; throws?: boolean }>
): void {
  execaMock.mockImplementation((_cmd: string, args: string[]) => {
    // Drop the leading -C <repoPath>
    const key = args.slice(2).join(' ');
    const match = routes[key];
    if (!match) {
      throw Object.assign(new Error(`unmatched execa: ${key}`), {
        stderr: 'unknown revision'
      });
    }
    if (match.throws) {
      throw Object.assign(new Error('git err'), { stderr: match.stderr ?? '' });
    }
    return Promise.resolve({ stdout: match.stdout ?? '', stderr: '' });
  });
}

const FMT = '%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%at%x1f%ct%x1f%aI%x1f%s%x1f%b%x1e';

function logRecord(
  sha: string,
  author: string,
  date: string,
  subject: string,
  body: string,
  opts: {
    parents?: string;
    authorEmail?: string;
    committerName?: string;
    committerEmail?: string;
    authoredAt?: string;
    committedAt?: string;
  } = {}
): string {
  const parents = opts.parents ?? '';
  const ae = opts.authorEmail ?? '';
  const cn = opts.committerName ?? author;
  const ce = opts.committerEmail ?? ae;
  const at = opts.authoredAt ?? '0';
  const ct = opts.committedAt ?? '0';
  return `${sha}\x1f${parents}\x1f${author}\x1f${ae}\x1f${cn}\x1f${ce}\x1f${at}\x1f${ct}\x1f${date}\x1f${subject}\x1f${body}\x1e`;
}

describe('listAgentCommitsViaMergeBase', () => {
  it('returns [] when the branch does not exist', async () => {
    routeExeca({
      'rev-parse --verify refs/heads/gone': { throws: true, stderr: "unknown revision or path 'gone'" }
    });
    const out = await listAgentCommitsViaMergeBase('/repo', 'gone', 'main');
    expect(out).toEqual([]);
  });

  it('runs merge-base then log over <base>..<branch> on the happy path', async () => {
    routeExeca({
      'rev-parse --verify refs/heads/feature': { stdout: 'abc' },
      'merge-base feature main': { stdout: 'BASE\n' },
      [`log --pretty=format:${FMT} --no-merges BASE..feature`]: {
        stdout:
          logRecord('sha1ABCDEF1234567890', 'Alice', '2026-01-01T00:00:00Z', 'Subject one', 'Body one\n') +
          '\n' +
          logRecord('sha2BCDEFF1234567890', 'Bob', '2026-01-02T00:00:00Z', 'Subject two', '')
      }
    });
    const out = await listAgentCommitsViaMergeBase('/repo', 'feature', 'main');
    expect(out).toHaveLength(2);
    const first = out[0]!;
    const second = out[1]!;
    expect(first.sha).toBe('sha1ABCDEF1234567890');
    expect(first.shortSha).toBe('sha1ABC');
    expect(first.authorName).toBe('Alice');
    expect(first.date).toBe('2026-01-01T00:00:00Z');
    expect(first.subject).toBe('Subject one');
    expect(first.body).toBe('Body one');
    expect(second.body).toBe(''); // trimmed trailing newlines
  });

  it('returns [] when the range has no commits (log stdout blank)', async () => {
    routeExeca({
      'rev-parse --verify refs/heads/empty': { stdout: 'ok' },
      'merge-base empty main': { stdout: 'BASE\n' },
      [`log --pretty=format:${FMT} --no-merges BASE..empty`]: {
        stdout: ''
      }
    });
    const out = await listAgentCommitsViaMergeBase('/repo', 'empty', 'main');
    expect(out).toEqual([]);
  });

  it('falls back to the full branch log when merge-base fails', async () => {
    routeExeca({
      'rev-parse --verify refs/heads/orphan': { stdout: 'ok' },
      'merge-base orphan main': { throws: true, stderr: 'no common ancestor' },
      [`log --pretty=format:${FMT} --no-merges orphan`]: {
        stdout: logRecord('sha3', 'Carol', '2026-01-03T00:00:00Z', 'orphan commit', '')
      }
    });
    const out = await listAgentCommitsViaMergeBase('/repo', 'orphan', 'main');
    expect(out).toHaveLength(1);
    expect(out[0]!.subject).toBe('orphan commit');
  });

  it('falls back to branch-only range when merge-base returns blank (disjoint history)', async () => {
    routeExeca({
      'rev-parse --verify refs/heads/x': { stdout: 'ok' },
      'merge-base x main': { stdout: '   \n' }, // blank after trim
      [`log --pretty=format:${FMT} --no-merges x`]: {
        stdout: logRecord('shaX', 'Dan', '2026-01-04T00:00:00Z', 's', 'b')
      }
    });
    const out = await listAgentCommitsViaMergeBase('/repo', 'x', 'main');
    expect(out[0]!.sha).toBe('shaX');
  });

  it('shortSha is the first 7 characters of sha', async () => {
    routeExeca({
      'rev-parse --verify refs/heads/f': { stdout: 'ok' },
      'merge-base f main': { stdout: 'b' },
      [`log --pretty=format:${FMT} --no-merges b..f`]: {
        stdout: logRecord('deadbeefcafef00d', 'A', 'D', 'S', '')
      }
    });
    const out = await listAgentCommitsViaMergeBase('/repo', 'f', 'main');
    expect(out[0]!.shortSha).toBe('deadbee');
  });
});

describe('revParseQuiet', () => {
  it('returns true when rev-parse exits 0', async () => {
    routeExeca({ 'rev-parse --verify refs/heads/main': { stdout: 'abc' } });
    await expect(revParseQuiet('/repo', 'refs/heads/main')).resolves.toBe(true);
  });
  it('returns false when rev-parse throws', async () => {
    routeExeca({ 'rev-parse --verify refs/heads/gone': { throws: true } });
    await expect(revParseQuiet('/repo', 'refs/heads/gone')).resolves.toBe(false);
  });
});

describe('catFileExists', () => {
  it('returns true when cat-file -e exits 0', async () => {
    routeExeca({ 'cat-file -e deadbeef': { stdout: '' } });
    await expect(catFileExists('/repo', 'deadbeef')).resolves.toBe(true);
  });
  it('returns false when cat-file -e throws', async () => {
    routeExeca({ 'cat-file -e deadbeef': { throws: true } });
    await expect(catFileExists('/repo', 'deadbeef')).resolves.toBe(false);
  });
});

describe('checkShaReachability', () => {
  it('returns empty set for empty input', async () => {
    const out = await checkShaReachability('/repo', []);
    expect(out.size).toBe(0);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('returns the subset reachable from remote-tracking refs', async () => {
    // 1st call: has-remote probe (returns a ref → remote exists).
    // Subsequent calls: per-sha `for-each-ref --contains`.
    execaMock.mockImplementation((_cmd, args: string[]) => {
      const a = args.slice(2);
      if (a.includes('--count=1') && !a.includes('--contains')) {
        // probe
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' });
      }
      const i = a.indexOf('--contains');
      const sha = a[i + 1];
      const onRemote = sha === 'aaa1111' || sha === 'ccc3333';
      return Promise.resolve({
        stdout: onRemote ? 'refs/remotes/origin/main\n' : '',
        stderr: ''
      });
    });
    const out = await checkShaReachability('/repo', ['aaa1111', 'bbb2222', 'ccc3333']);
    expect([...out].sort()).toEqual(['aaa1111', 'ccc3333']);
  });

  it('falls back to local object DB when no remote refs exist', async () => {
    execaMock.mockImplementation((_cmd, args: string[]) => {
      const a = args.slice(2);
      if (a.includes('for-each-ref')) {
        // probe returns empty → no remote
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (a[0] === 'cat-file' && a[1] === '--batch-check=%(objectname) %(objecttype)') {
        return Promise.resolve({
          stdout: 'aaa1111 commit\nbbb2222 missing\nccc3333 commit',
          stderr: ''
        });
      }
      throw new Error(`unmatched: ${a.join(' ')}`);
    });
    const out = await checkShaReachability('/repo', ['aaa1111', 'bbb2222', 'ccc3333']);
    expect([...out].sort()).toEqual(['aaa1111', 'ccc3333']);
  });

  it('marks a locally-present sha unreachable when no remote ref contains it', async () => {
    // Models the rebase/recommit case: old SHA still loose in the local
    // object DB, but gone from every remote-tracking ref.
    execaMock.mockImplementation((_cmd, args: string[]) => {
      const a = args.slice(2);
      if (a.includes('--count=1') && !a.includes('--contains')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' });
      }
      // Every per-sha containment check returns empty (no remote ref contains it).
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    const out = await checkShaReachability('/repo', ['96534ce']);
    expect(out.size).toBe(0);
  });

  it('deduplicates input shas before checking', async () => {
    const seen: string[] = [];
    execaMock.mockImplementation((_cmd, args: string[]) => {
      const a = args.slice(2);
      if (a.includes('--count=1') && !a.includes('--contains')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' });
      }
      const i = a.indexOf('--contains');
      if (i >= 0) seen.push(a[i + 1]!);
      return Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' });
    });
    const out = await checkShaReachability('/repo', ['aaa', 'aaa', 'aaa']);
    expect(out.has('aaa')).toBe(true);
    expect(seen).toEqual(['aaa']);
  });

  it('returns empty set when the probe throws', async () => {
    execaMock.mockRejectedValue(Object.assign(new Error('git fail'), { stderr: '' }));
    const out = await checkShaReachability('/repo', ['aaa', 'bbb']);
    expect(out.size).toBe(0);
  });

  it('treats per-sha containment failure as unreachable', async () => {
    execaMock.mockImplementation((_cmd, args: string[]) => {
      const a = args.slice(2);
      if (a.includes('--count=1') && !a.includes('--contains')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n', stderr: '' });
      }
      throw Object.assign(new Error('bad rev'), { stderr: '' });
    });
    const out = await checkShaReachability('/repo', ['aaa']);
    expect(out.size).toBe(0);
  });
});
