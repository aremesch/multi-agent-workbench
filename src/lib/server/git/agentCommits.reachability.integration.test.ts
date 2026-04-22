/**
 * Real-git integration test for `checkShaReachability`.
 *
 * The unit tests use a mocked execa, so they don't exercise the actual
 * git plumbing. This test builds a throwaway repo with a fake remote
 * and asserts the end-to-end semantics:
 *
 *   - A commit reachable from a remote-tracking ref → reachable.
 *   - A commit that is LOCALLY PRESENT but NOT on any remote ref →
 *     unreachable. This is the exact case the archive strikethrough is
 *     supposed to catch: after a rebase/recommit, the old SHA lingers
 *     in the local object DB until GC but the upstream link 404s.
 *   - A SHA that doesn't exist at all → unreachable.
 *   - A repo with no remote → falls back to local object existence.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkShaReachability } from './agentCommits.js';

const TMP_BASE = join(tmpdir(), 'maw-reachability-');

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', cwd, ...args]);
  return stdout;
}

async function initRepo(path: string): Promise<void> {
  await execa('git', ['init', '-q', '-b', 'main', path]);
  // Avoid the "set your identity" warning.
  await git(path, 'config', 'user.email', 'test@maw.local');
  await git(path, 'config', 'user.name', 'Test');
}

async function commitFile(path: string, name: string, contents: string): Promise<string> {
  writeFileSync(join(path, name), contents);
  await git(path, 'add', name);
  await git(path, 'commit', '-q', '-m', `add ${name}`);
  return (await git(path, 'rev-parse', 'HEAD')).trim();
}

describe('checkShaReachability (real git)', () => {
  let bare: string;
  let local: string;
  let orphanLocal: string;

  beforeAll(async () => {
    bare = mkdtempSync(TMP_BASE) + '-bare.git';
    local = mkdtempSync(TMP_BASE) + '-local';
    orphanLocal = mkdtempSync(TMP_BASE) + '-orphan';

    await execa('git', ['init', '-q', '--bare', '-b', 'main', bare]);

    await initRepo(local);
    await commitFile(local, 'a.txt', 'a');
    await git(local, 'remote', 'add', 'origin', bare);
    await git(local, 'push', '-q', 'origin', 'main');

    await initRepo(orphanLocal);
    await commitFile(orphanLocal, 'x.txt', 'x');
  });

  afterAll(() => {
    for (const p of [bare, local, orphanLocal]) {
      if (p) rmSync(p, { recursive: true, force: true });
    }
  });

  it('marks a commit reachable when the remote-tracking ref contains it', async () => {
    const sha = (await git(local, 'rev-parse', 'HEAD')).trim();
    const out = await checkShaReachability(local, [sha]);
    expect(out.has(sha)).toBe(true);
  });

  it('marks a locally-present commit unreachable when NO remote ref contains it', async () => {
    // Make a fresh local commit and DO NOT push it. The object exists
    // in .git/objects (so `git cat-file -e` would still say "present"),
    // but no `refs/remotes/origin/*` ref contains it.
    const staleSha = await commitFile(local, 'b.txt', 'b');
    // Move HEAD backward so the commit becomes unreferenced by any
    // local branch either — mimics the rebased/abandoned case.
    await git(local, 'reset', '-q', '--hard', 'HEAD^');

    // Sanity: the object is still locally present.
    await expect(execa('git', ['-C', local, 'cat-file', '-e', staleSha])).resolves.toBeTruthy();

    const out = await checkShaReachability(local, [staleSha]);
    expect(out.has(staleSha)).toBe(false);
  });

  it('returns an empty set when the SHA does not exist at all', async () => {
    const out = await checkShaReachability(local, ['deadbee7cafef00d1234567890abcdef12345678']);
    expect(out.size).toBe(0);
  });

  it('falls back to local object existence when the repo has no remote', async () => {
    const sha = (await git(orphanLocal, 'rev-parse', 'HEAD')).trim();
    const out = await checkShaReachability(orphanLocal, [sha]);
    expect(out.has(sha)).toBe(true);

    const missing = await checkShaReachability(orphanLocal, [
      'deadbee7cafef00d1234567890abcdef12345678'
    ]);
    expect(missing.size).toBe(0);
  });
});
