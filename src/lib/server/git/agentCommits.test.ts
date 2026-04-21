import { beforeEach, describe, expect, it, vi } from 'vitest';

// Scripted execa mock: each test registers handlers keyed by the joined
// argv; the mock looks up the right response or calls the router fn.
const execaMock = vi.fn();
vi.mock('execa', () => ({
  execa: (cmd: string, args: string[]) => execaMock(cmd, args)
}));

import { listAgentCommitsViaMergeBase } from './agentCommits.js';

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
