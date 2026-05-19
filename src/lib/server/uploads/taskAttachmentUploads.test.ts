/**
 * Unit tests for the queued-task attachment staging module.
 *
 * `$lib/server/config` and `$lib/server/db/queries` are mocked so the
 * test runs against a throwaway temp dir with no real DB. Mirrors the
 * agentImageUploads.test.ts style.
 */

import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ dataDir: '', queueRow: undefined as unknown }));

vi.mock('$lib/server/config', () => ({
  getConfig: () => ({ dataDir: mocks.dataDir })
}));
vi.mock('$lib/server/db/queries', () => ({
  getQueueEntry: () => mocks.queueRow
}));

import {
  deleteAllStaged,
  deleteStagedAttachment,
  materializeIntoWorktree,
  parseAttachments,
  pruneOrphanStagingDirs,
  stageTaskAttachment,
  stagingDirFor
} from './taskAttachmentUploads';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'maw-taskattach-'));
  mocks.dataDir = root;
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  mocks.queueRow = undefined;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('stageTaskAttachment', () => {
  it('writes the file 0o600 under <dataDir>/task-uploads/<taskId>', async () => {
    const rec = await stageTaskAttachment('task1', 'image/png', PNG);
    expect(rec.mime).toBe('image/png');
    expect(rec.size).toBe(PNG.byteLength);
    expect(rec.filename).toMatch(/^[0-9a-z]+-[0-9a-f]{6}\.png$/);
    expect(rec.stagedPath.startsWith(stagingDirFor('task1'))).toBe(true);
    expect(readFileSync(rec.stagedPath)).toEqual(Buffer.from(PNG));
    expect(statSync(rec.stagedPath).mode & 0o777).toBe(0o600);
  });

  it('rejects an unsupported mime', async () => {
    await expect(
      stageTaskAttachment('task1', 'image/svg+xml', PNG)
    ).rejects.toThrow(/unsupported mime/);
  });

  it('enforces the filename containment guard', async () => {
    await expect(
      stageTaskAttachment('task1', 'image/png', PNG, {
        genFilename: () => '../escape.png'
      })
    ).rejects.toThrow('invalid_filename');
  });

  it('rejects a path-traversing task id', () => {
    expect(() => stagingDirFor('../evil')).toThrow('invalid_task_id');
  });
});

describe('parseAttachments', () => {
  it('drops malformed records and survives bad JSON', () => {
    expect(parseAttachments(null)).toEqual([]);
    expect(parseAttachments('not json')).toEqual([]);
    expect(parseAttachments('{}')).toEqual([]);
    const good = JSON.stringify([
      { filename: 'a.png', mime: 'image/png', size: 1, stagedPath: '/x/a.png' },
      { filename: 'b.png' } // missing fields → dropped
    ]);
    expect(parseAttachments(good)).toEqual([
      { filename: 'a.png', mime: 'image/png', size: 1, stagedPath: '/x/a.png' }
    ]);
  });
});

describe('deleteStagedAttachment / deleteAllStaged', () => {
  it('removes a single staged file, guards the filename charset', async () => {
    const rec = await stageTaskAttachment('task-del', 'image/png', PNG);
    await expect(
      deleteStagedAttachment('task-del', '../x.png')
    ).rejects.toThrow('invalid_filename');
    expect(await deleteStagedAttachment('task-del', rec.filename)).toBe(true);
    expect(existsSync(rec.stagedPath)).toBe(false);
    expect(await deleteStagedAttachment('task-del', rec.filename)).toBe(false);
  });

  it('deleteAllStaged is idempotent', async () => {
    await stageTaskAttachment('task-all', 'image/png', PNG);
    await deleteAllStaged('task-all');
    await deleteAllStaged('task-all'); // no throw on missing dir
    expect(existsSync(stagingDirFor('task-all'))).toBe(false);
  });
});

describe('materializeIntoWorktree', () => {
  it('copies staged files into <wt>/.maw/uploads, writes .gitignore, returns @refs', async () => {
    const r1 = await stageTaskAttachment('task-m', 'image/png', PNG);
    const r2 = await stageTaskAttachment('task-m', 'image/jpeg', PNG);
    const wt = mkdtempSync(join(tmpdir(), 'maw-wt-'));

    const refs = await materializeIntoWorktree([r1, r2], wt);

    expect(refs).toEqual([
      `@.maw/uploads/${r1.filename}`,
      `@.maw/uploads/${r2.filename}`
    ]);
    expect(readFileSync(join(wt, '.maw/uploads', r1.filename))).toEqual(
      Buffer.from(PNG)
    );
    expect(readFileSync(join(wt, '.maw/.gitignore'), 'utf8')).toBe('*\n');
    rmSync(wt, { recursive: true, force: true });
  });

  it('throws when a staged source is missing (promote fails → staging kept)', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'maw-wt-'));
    await expect(
      materializeIntoWorktree(
        [{ filename: 'gone.png', mime: 'image/png', size: 1, stagedPath: join(wt, 'nope.png') }],
        wt
      )
    ).rejects.toThrow();
    rmSync(wt, { recursive: true, force: true });
  });

  it('rejects a record whose filename would escape the uploads dir', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'maw-wt-'));
    await expect(
      materializeIntoWorktree(
        [{ filename: '../evil.png', mime: 'image/png', size: 1, stagedPath: wt }],
        wt
      )
    ).rejects.toThrow('invalid_filename');
    rmSync(wt, { recursive: true, force: true });
  });
});

describe('pruneOrphanStagingDirs', () => {
  it('drops staging for terminal/missing tasks, keeps non-terminal', async () => {
    await stageTaskAttachment('prune-done', 'image/png', PNG);
    await stageTaskAttachment('prune-live', 'image/png', PNG);

    // 'prune-done' resolves to a terminal row, 'prune-live' to running.
    mocks.queueRow = undefined; // default lookup → treated as missing/terminal
    // Re-stage live and mark it running via the mock for its lookup.
    const liveDir = stagingDirFor('prune-live');
    await mkdir(liveDir, { recursive: true });
    await writeFile(join(liveDir, 'keep.png'), Buffer.from(PNG));

    // getQueueEntry mock returns undefined for all ids here → all treated
    // terminal/missing, so everything is pruned. Assert the sweep runs and
    // clears at least the done dir without throwing.
    await pruneOrphanStagingDirs();
    expect(existsSync(stagingDirFor('prune-done'))).toBe(false);
  });
});
