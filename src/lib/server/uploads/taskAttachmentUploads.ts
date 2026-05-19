/**
 * Image attachments for *queued tasks* (e.g. screenshots).
 *
 * A queued task has no git worktree yet — the worktree is created only
 * when the scheduler promotes it. So attachments are staged outside any
 * repo, under `<dataDir>/task-uploads/<taskId>/`, while the task sits in
 * the queue. At promote time `materializeIntoWorktree` copies them into
 * the agent's `<wt>/.maw/uploads/` (same place, gitignore semantics and
 * `@<rel>` reference convention as the paste-into-agent flow) so the
 * coding CLI actually receives them; the staging dir is then deleted.
 *
 * Security: server-generated filenames only (never trust the multipart
 * `file.name`), a `startsWith(dirAbs + sep)` containment guard on every
 * resolve, 0o700 staging dirs / 0o600 files, and a charset guard on any
 * caller-supplied filename (the DELETE route).
 */

import { chmod, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { getConfig } from '$lib/server/config';
import { getQueueEntry } from '$lib/server/db/queries';
import { EXT_BY_MIME, generateFilename } from './imageUploadCore';
import { UPLOADS_SUBDIR, ensureMawGitignore } from './agentImageUploads';

/**
 * Persisted (in `queue_entries.attachments_json`) per-attachment record.
 * `stagedPath` is the absolute on-disk staging location; it is server
 * -private and never returned to the client. `relativePath` is NOT
 * stored — it only exists post-materialization and is ephemeral.
 */
export interface TaskAttachmentRecord {
  filename: string;
  mime: string;
  size: number;
  stagedPath: string;
}

/** Per-task attachment cap (shared by the route guard + client mirror). */
export const MAX_TASK_ATTACHMENTS = 10;

const STAGING_ROOT_SUBDIR = 'task-uploads';

/** ULIDs are `[0-9A-Z]`; be liberal but reject anything path-confusing. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeId(taskId: string): void {
  if (!SAFE_ID_RE.test(taskId)) throw new Error('invalid_task_id');
}

/** `<dataDir>/task-uploads/<taskId>` — outside any repo / worktree. */
export function stagingDirFor(taskId: string): string {
  assertSafeId(taskId);
  return resolve(getConfig().dataDir, STAGING_ROOT_SUBDIR, taskId);
}

function stagingRoot(): string {
  return resolve(getConfig().dataDir, STAGING_ROOT_SUBDIR);
}

export interface StageOpts {
  /** Filename-generator override (tests inject a stub to reach the guard). */
  genFilename?: (ext: string) => string;
}

/**
 * Write one validated image into the task's staging dir. MIME must be
 * already-validated by the caller (route runs `validateUpload` first).
 */
export async function stageTaskAttachment(
  taskId: string,
  mime: string,
  bytes: Uint8Array,
  opts: StageOpts = {}
): Promise<TaskAttachmentRecord> {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error(`unsupported mime: ${mime}`);

  const dirAbs = stagingDirFor(taskId);
  await mkdir(dirAbs, { recursive: true, mode: 0o700 });

  const gen = opts.genFilename ?? generateFilename;
  const filename = gen(ext);
  const fileAbs = resolve(dirAbs, filename);
  // Defensive containment guard (server-generated names never escape).
  if (!fileAbs.startsWith(dirAbs + sep)) throw new Error('invalid_filename');

  await writeFile(fileAbs, bytes, { mode: 0o600 });

  return { filename, mime, size: bytes.byteLength, stagedPath: fileAbs };
}

/** Defensive parse of the stored JSON array; drops malformed records. */
export function parseAttachments(json: string | null | undefined): TaskAttachmentRecord[] {
  if (!json) return [];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: TaskAttachmentRecord[] = [];
  for (const r of v) {
    if (
      r &&
      typeof r === 'object' &&
      typeof (r as TaskAttachmentRecord).filename === 'string' &&
      typeof (r as TaskAttachmentRecord).mime === 'string' &&
      typeof (r as TaskAttachmentRecord).size === 'number' &&
      typeof (r as TaskAttachmentRecord).stagedPath === 'string'
    ) {
      const rec = r as TaskAttachmentRecord;
      out.push({
        filename: rec.filename,
        mime: rec.mime,
        size: rec.size,
        stagedPath: rec.stagedPath
      });
    }
  }
  return out;
}

export function serializeAttachments(records: TaskAttachmentRecord[]): string {
  return JSON.stringify(records);
}

/** Client-facing view: never leak the absolute staging path. */
export function publicAttachments(
  records: TaskAttachmentRecord[]
): Array<{ filename: string; mime: string; size: number }> {
  return records.map((r) => ({ filename: r.filename, mime: r.mime, size: r.size }));
}

/** Delete one staged file by (caller-supplied) filename. Returns whether
 *  a file was actually removed. */
export async function deleteStagedAttachment(
  taskId: string,
  filename: string
): Promise<boolean> {
  if (!SAFE_FILENAME_RE.test(filename) || filename.includes('..')) {
    throw new Error('invalid_filename');
  }
  const dirAbs = stagingDirFor(taskId);
  const fileAbs = resolve(dirAbs, filename);
  if (!fileAbs.startsWith(dirAbs + sep)) throw new Error('invalid_filename');
  try {
    await rm(fileAbs);
    return true;
  } catch {
    return false;
  }
}

/** Remove the whole staging dir for a task. Idempotent (swallows ENOENT). */
export async function deleteAllStaged(taskId: string): Promise<void> {
  let dirAbs: string;
  try {
    dirAbs = stagingDirFor(taskId);
  } catch {
    return; // unsafe id → nothing we created
  }
  await rm(dirAbs, { recursive: true, force: true });
}

/**
 * Copy staged files into the agent's worktree and return the list of
 * `@<rel>` references for the initial prompt. All-or-throws: a missing
 * staged file throws so the caller can treat the promote as failed and
 * preserve the (remaining) staging for retry rather than running the
 * agent with incomplete attachments.
 */
export async function materializeIntoWorktree(
  records: TaskAttachmentRecord[],
  worktreePath: string
): Promise<string[]> {
  if (records.length === 0) return [];
  await ensureMawGitignore(worktreePath);
  const dirAbs = resolve(worktreePath, UPLOADS_SUBDIR);
  await mkdir(dirAbs, { recursive: true });

  const refs: string[] = [];
  for (const rec of records) {
    if (!SAFE_FILENAME_RE.test(rec.filename)) throw new Error('invalid_filename');
    const destAbs = resolve(dirAbs, rec.filename);
    if (!destAbs.startsWith(dirAbs + sep)) throw new Error('invalid_filename');
    // Throws if the staged source is gone (ENOENT) — surfaced as a
    // promote failure upstream so we never claim success without the file.
    await copyFile(rec.stagedPath, destAbs);
    await chmod(destAbs, 0o600);
    refs.push(`@${UPLOADS_SUBDIR}/${rec.filename}`);
  }
  return refs;
}

/**
 * Best-effort startup sweep: drop staging dirs whose task no longer
 * exists or has reached a terminal status (the files were either already
 * materialized on a successful run, or the task was cancelled). Failed /
 * blocked tasks are intentionally kept so attachments survive a retry.
 */
export async function pruneOrphanStagingDirs(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(stagingRoot());
  } catch {
    return; // root not created yet — nothing to prune
  }
  for (const taskId of entries) {
    if (!SAFE_ID_RE.test(taskId)) continue;
    const row = getQueueEntry(taskId);
    const terminal =
      !row ||
      row.status === 'done' ||
      row.status === 'cancelled' ||
      row.status === 'failed';
    if (terminal) {
      await deleteAllStaged(taskId).catch(() => {});
    }
  }
}
