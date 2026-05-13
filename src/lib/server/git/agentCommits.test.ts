import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimpleGit } from 'simple-git';

// Scripted mocks. Most calls go through simple-git's client (.raw(),
// .revparse()); the one stdin case in checkShaReachability still uses
// execa, so both surfaces are mocked.
const rawMock = vi.fn();
const revparseMock = vi.fn();
const getGitMock = vi.fn();
const execaMock = vi.fn();

vi.mock('$lib/server/git/client', () => ({
  getGit: (cwd?: string) => getGitMock(cwd)
}));

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
  rawMock.mockReset();
  revparseMock.mockReset();
  getGitMock.mockReset();
  getGitMock.mockReturnValue({
    raw: rawMock,
    revparse: revparseMock
  } as unknown as SimpleGit);
  execaMock.mockReset();
});

/** Route .raw() calls by matching on the args array joined. */
function routeRaw(
  routes: Record<string, { stdout?: string; throws?: boolean }>
): void {
  rawMock.mockImplementation((args: string[]) => {
    const key = args.join(' ');
    const match = routes[key];
    if (!match) {
      throw new Error(`unmatched raw: ${key}`);
    }
    if (match.throws) {
      throw new Error('git err');
    }
    return Promise.resolve(match.stdout ?? '');
  });
}

/** Route .revparse() calls by matching on the args array joined. */
function routeRevparse(
  routes: Record<string, { stdout?: string; throws?: boolean }>
): void {
  revparseMock.mockImplementation((args: string[]) => {
    const key = args.join(' ');
    const match = routes[key];
    if (!match) {
      throw new Error(`unmatched revparse: ${key}`);
    }
    if (match.throws) {
      throw new Error('git err');
    }
    return Promise.resolve(match.stdout ?? '');
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
    routeRevparse({
      '--verify refs/heads/gone': { throws: true }
    });
    const out = await listAgentCommitsViaMergeBase('/repo', 'gone', 'main');
    expect(out).toEqual([]);
  });

  it('runs merge-base then log over <base>..<branch> on the happy path', async () => {
    routeRevparse({
      '--verify refs/heads/feature': { stdout: 'abc' }
    });
    routeRaw({
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
    routeRevparse({
      '--verify refs/heads/empty': { stdout: 'ok' }
    });
    routeRaw({
      'merge-base empty main': { stdout: 'BASE\n' },
      [`log --pretty=format:${FMT} --no-merges BASE..empty`]: {
        stdout: ''
      }
    });
    const out = await listAgentCommitsViaMergeBase('/repo', 'empty', 'main');
    expect(out).toEqual([]);
  });

  it('falls back to the full branch log when merge-base fails', async () => {
    routeRevparse({
      '--verify refs/heads/orphan': { stdout: 'ok' }
    });
    routeRaw({
      'merge-base orphan main': { throws: true },
      [`log --pretty=format:${FMT} --no-merges orphan`]: {
        stdout: logRecord('sha3', 'Carol', '2026-01-03T00:00:00Z', 'orphan commit', '')
      }
    });
    const out = await listAgentCommitsViaMergeBase('/repo', 'orphan', 'main');
    expect(out).toHaveLength(1);
    expect(out[0]!.subject).toBe('orphan commit');
  });

  it('falls back to branch-only range when merge-base returns blank (disjoint history)', async () => {
    routeRevparse({
      '--verify refs/heads/x': { stdout: 'ok' }
    });
    routeRaw({
      'merge-base x main': { stdout: '   \n' }, // blank after trim
      [`log --pretty=format:${FMT} --no-merges x`]: {
        stdout: logRecord('shaX', 'Dan', '2026-01-04T00:00:00Z', 's', 'b')
      }
    });
    const out = await listAgentCommitsViaMergeBase('/repo', 'x', 'main');
    expect(out[0]!.sha).toBe('shaX');
  });

  it('shortSha is the first 7 characters of sha', async () => {
    routeRevparse({
      '--verify refs/heads/f': { stdout: 'ok' }
    });
    routeRaw({
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
    routeRevparse({ '--verify refs/heads/main': { stdout: 'abc' } });
    await expect(revParseQuiet('/repo', 'refs/heads/main')).resolves.toBe(true);
  });
  it('returns false when rev-parse throws', async () => {
    routeRevparse({ '--verify refs/heads/gone': { throws: true } });
    await expect(revParseQuiet('/repo', 'refs/heads/gone')).resolves.toBe(false);
  });
});

describe('catFileExists', () => {
  it('returns true when cat-file -e exits 0', async () => {
    routeRaw({ 'cat-file -e deadbeef': { stdout: '' } });
    await expect(catFileExists('/repo', 'deadbeef')).resolves.toBe(true);
  });
  it('returns false when cat-file -e throws', async () => {
    routeRaw({ 'cat-file -e deadbeef': { throws: true } });
    await expect(catFileExists('/repo', 'deadbeef')).resolves.toBe(false);
  });
});

describe('checkShaReachability', () => {
  it('returns empty set for empty input', async () => {
    const out = await checkShaReachability('/repo', []);
    expect(out.size).toBe(0);
    expect(rawMock).not.toHaveBeenCalled();
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('returns the subset reachable from remote-tracking refs', async () => {
    // 1st call: has-remote probe (returns a ref → remote exists).
    // Subsequent calls: per-sha `for-each-ref --contains`.
    rawMock.mockImplementation((args: string[]) => {
      if (args.includes('--count=1') && !args.includes('--contains')) {
        return Promise.resolve('refs/remotes/origin/main\n');
      }
      const i = args.indexOf('--contains');
      const sha = args[i + 1];
      const onRemote = sha === 'aaa1111' || sha === 'ccc3333';
      return Promise.resolve(onRemote ? 'refs/remotes/origin/main\n' : '');
    });
    const out = await checkShaReachability('/repo', ['aaa1111', 'bbb2222', 'ccc3333']);
    expect([...out].sort()).toEqual(['aaa1111', 'ccc3333']);
  });

  it('falls back to local object DB when no remote refs exist', async () => {
    rawMock.mockImplementation((args: string[]) => {
      if (args.includes('for-each-ref')) {
        // probe returns empty → no remote
        return Promise.resolve('');
      }
      throw new Error(`unmatched raw: ${args.join(' ')}`);
    });
    // cat-file --batch-check uses execa because it needs stdin
    execaMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('cat-file') && args.some((a) => a.startsWith('--batch-check='))) {
        return Promise.resolve({
          stdout: 'aaa1111 commit\nbbb2222 missing\nccc3333 commit',
          stderr: ''
        });
      }
      throw new Error(`unmatched execa: ${args.join(' ')}`);
    });
    const out = await checkShaReachability('/repo', ['aaa1111', 'bbb2222', 'ccc3333']);
    expect([...out].sort()).toEqual(['aaa1111', 'ccc3333']);
  });

  it('marks a locally-present sha unreachable when no remote ref contains it', async () => {
    // Models the rebase/recommit case: old SHA still loose in the local
    // object DB, but gone from every remote-tracking ref.
    rawMock.mockImplementation((args: string[]) => {
      if (args.includes('--count=1') && !args.includes('--contains')) {
        return Promise.resolve('refs/remotes/origin/main\n');
      }
      // Every per-sha containment check returns empty.
      return Promise.resolve('');
    });
    const out = await checkShaReachability('/repo', ['96534ce']);
    expect(out.size).toBe(0);
  });

  it('deduplicates input shas before checking', async () => {
    const seen: string[] = [];
    rawMock.mockImplementation((args: string[]) => {
      if (args.includes('--count=1') && !args.includes('--contains')) {
        return Promise.resolve('refs/remotes/origin/main\n');
      }
      const i = args.indexOf('--contains');
      if (i >= 0) seen.push(args[i + 1]!);
      return Promise.resolve('refs/remotes/origin/main\n');
    });
    const out = await checkShaReachability('/repo', ['aaa', 'aaa', 'aaa']);
    expect(out.has('aaa')).toBe(true);
    expect(seen).toEqual(['aaa']);
  });

  it('returns empty set when the probe throws', async () => {
    rawMock.mockRejectedValue(new Error('git fail'));
    execaMock.mockRejectedValue(new Error('git fail'));
    const out = await checkShaReachability('/repo', ['aaa', 'bbb']);
    expect(out.size).toBe(0);
  });

  it('treats per-sha containment failure as unreachable', async () => {
    rawMock.mockImplementation((args: string[]) => {
      if (args.includes('--count=1') && !args.includes('--contains')) {
        return Promise.resolve('refs/remotes/origin/main\n');
      }
      throw new Error('bad rev');
    });
    const out = await checkShaReachability('/repo', ['aaa']);
    expect(out.size).toBe(0);
  });
});
