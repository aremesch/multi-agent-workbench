/**
 * Tests for the "Show Changes" git diff helper.
 *
 * Two layers:
 *   - Integration against a real temp git repo (init → base commit → more
 *     commits → dirty working tree), exercising the committed + uncommitted
 *     section builders end to end.
 *   - Pure unit tests for `parseUnifiedDiff` / `mergeNumstat` / `parseNumstatPath`
 *     on canned patch strings (renames, deletes, no-newline, binary).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGit } from './client';
import {
  getAgentChanges,
  getCommittedDiff,
  getUncommittedDiff,
  mergeNumstat,
  parseNumstatPath,
  parseUnifiedDiff,
  type DiffFile
} from './agentDiff';

/** Parse and assert exactly one file, returning it non-null for downstream use. */
function only(patch: string): DiffFile {
  const files = parseUnifiedDiff(patch);
  expect(files).toHaveLength(1);
  return files[0]!;
}

// ── Pure parser unit tests ──────────────────────────────────────────────────

describe('parseUnifiedDiff', () => {
  it('parses a simple modification with line numbers', () => {
    const file = only(
      [
        'diff --git a/foo.txt b/foo.txt',
        'index 111..222 100644',
        '--- a/foo.txt',
        '+++ b/foo.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+TWO',
        ' three'
      ].join('\n')
    );
    expect(file.path).toBe('foo.txt');
    expect(file.status).toBe('M');
    expect(file.added).toBe(1);
    expect(file.removed).toBe(1);
    expect(file.hunks).toHaveLength(1);
    const lines = file.hunks[0]!.lines;
    expect(lines.map((l) => l.type)).toEqual(['context', 'del', 'add', 'context']);
    expect(lines[0]).toMatchObject({ oldNo: 1, newNo: 1, text: 'one' });
    expect(lines[1]).toMatchObject({ oldNo: 2, newNo: null, text: 'two' });
    expect(lines[2]).toMatchObject({ oldNo: null, newNo: 2, text: 'TWO' });
    expect(lines[3]).toMatchObject({ oldNo: 3, newNo: 3, text: 'three' });
  });

  it('detects added and deleted files', () => {
    const added = only(
      [
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        'index 000..abc',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,1 @@',
        '+hello'
      ].join('\n')
    );
    expect(added).toMatchObject({ status: 'A', path: 'new.txt' });

    const deleted = only(
      [
        'diff --git a/old.txt b/old.txt',
        'deleted file mode 100644',
        'index abc..000',
        '--- a/old.txt',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-bye'
      ].join('\n')
    );
    expect(deleted).toMatchObject({ status: 'D', path: 'old.txt' });
  });

  it('detects a rename with old + new paths', () => {
    const file = only(
      [
        'diff --git a/src/old.ts b/src/new.ts',
        'similarity index 100%',
        'rename from src/old.ts',
        'rename to src/new.ts'
      ].join('\n')
    );
    expect(file.status).toBe('R');
    expect(file.oldPath).toBe('src/old.ts');
    expect(file.path).toBe('src/new.ts');
    expect(file.hunks).toHaveLength(0);
  });

  it('tolerates "\\ No newline at end of file" without shifting line numbers', () => {
    const file = only(
      [
        'diff --git a/f b/f',
        '--- a/f',
        '+++ b/f',
        '@@ -1,1 +1,1 @@',
        '-a',
        '\\ No newline at end of file',
        '+b',
        '\\ No newline at end of file'
      ].join('\n')
    );
    expect(file.added).toBe(1);
    expect(file.removed).toBe(1);
    expect(file.hunks[0]!.lines).toHaveLength(2);
  });

  it('flags a binary file from the Binary marker', () => {
    const file = only(
      [
        'diff --git a/img.png b/img.png',
        'new file mode 100644',
        'index 000..abc',
        'Binary files /dev/null and b/img.png differ'
      ].join('\n')
    );
    expect(file.binary).toBe(true);
    expect(file.path).toBe('img.png');
  });
});

describe('mergeNumstat', () => {
  it('overlays authoritative counts and binary flags', () => {
    const files = parseUnifiedDiff(
      ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    );
    mergeNumstat(files, '5\t2\tx');
    expect(files[0]).toMatchObject({ added: 5, removed: 2 });

    const bin = parseUnifiedDiff(
      ['diff --git a/i.png b/i.png', 'Binary files a/i.png and b/i.png differ'].join('\n')
    );
    mergeNumstat(bin, '-\t-\ti.png');
    expect(bin[0]).toMatchObject({ binary: true, added: -1, removed: -1 });
  });
});

describe('parseNumstatPath', () => {
  it('extracts the new path from rename forms', () => {
    expect(parseNumstatPath('old.ts => new.ts')).toBe('new.ts');
    expect(parseNumstatPath('src/{old => new}/f.ts')).toBe('src/new/f.ts');
    expect(parseNumstatPath('plain/path.ts')).toBe('plain/path.ts');
  });
});

// ── Integration against a real temp git repo ────────────────────────────────

describe('getAgentChanges (integration)', () => {
  let dir: string;
  let baseSha: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'maw-diff-'));
    const git = getGit(dir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    await git.addConfig('commit.gpgsign', 'false');

    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    await git.add('.');
    await git.commit('base');
    baseSha = (await git.revparse(['HEAD'])).trim();

    // Second commit: modify a.txt, add b.txt, add a binary file.
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\n');
    await writeFile(join(dir, 'b.txt'), 'new file\n');
    await writeFile(join(dir, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]));
    await git.add('.');
    await git.commit('second');

    // Dirty working tree: unstaged edit to a tracked file + an untracked file.
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    await writeFile(join(dir, 'untracked.txt'), 'brand new\nlines\n');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports committed changes since base_sha', async () => {
    const section = await getCommittedDiff(dir, baseSha);
    expect(section.note).toBeNull();
    const byPath = new Map(section.files.map((f) => [f.path, f]));
    expect(byPath.get('a.txt')?.status).toBe('M');
    expect(byPath.get('b.txt')?.status).toBe('A');
    expect(byPath.get('img.bin')?.binary).toBe(true);
    expect(byPath.get('img.bin')?.added).toBe(-1);
    expect(section.totalAdded).toBeGreaterThan(0);
  });

  it('reports uncommitted changes including tracked + untracked', async () => {
    const section = await getUncommittedDiff(dir);
    const byPath = new Map(section.files.map((f) => [f.path, f]));
    expect(byPath.get('a.txt')?.status).toBe('M');
    const untracked = byPath.get('untracked.txt');
    expect(untracked?.status).toBe('A');
    expect(untracked?.added).toBe(2);
    expect(untracked?.hunks[0]?.lines).toHaveLength(2);
  });

  it('returns base_unavailable when the base sha is unreachable', async () => {
    const section = await getCommittedDiff(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(section.files).toHaveLength(0);
    expect(section.note).toBe('base_unavailable');
  });

  it('returns base_unavailable when base_sha is null', async () => {
    const section = await getCommittedDiff(dir, null);
    expect(section.note).toBe('base_unavailable');
  });

  it('reports worktree_gone for a missing directory', async () => {
    const changes = await getAgentChanges('/nonexistent/maw/worktree', baseSha);
    expect(changes.committed.note).toBe('worktree_gone');
    expect(changes.uncommitted.note).toBe('worktree_gone');
    expect(changes.headSha).toBeNull();
  });

  it('assembles both sections + head sha for a live worktree', async () => {
    const changes = await getAgentChanges(dir, baseSha);
    expect(changes.baseSha).toBe(baseSha);
    expect(changes.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(changes.committed.files.length).toBeGreaterThan(0);
    expect(changes.uncommitted.files.length).toBeGreaterThan(0);
  });
});
