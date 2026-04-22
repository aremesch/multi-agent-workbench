/**
 * Directory-picker backing helper.
 *
 * Given a requested absolute path and a sandbox root, returns a
 * listing of immediate child directories. Used by
 * `GET /api/fs/list` (the repo-creation Browse dialog).
 *
 * Security posture:
 *   - The requested path is resolved through `realpathSync` before the
 *     prefix check, so symlinks inside the sandbox that point outside
 *     are rejected.
 *   - The sandbox root itself is expected to be pre-realpath'd by the
 *     caller (see `getFsBrowseRoot` in config.ts) — a raw prefix
 *     compare alone is not enough if `$HOME` is itself a symlink.
 *   - Only directories are returned; file listings are never leaked.
 *   - No user-supplied string is ever passed to a shell command.
 */

import { realpathSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname, join, sep } from 'node:path';

export interface BrowseEntry {
  /** Name of the child directory (no path separator). */
  name: string;
  /** True when the child has a `.git` entry — flagged in the UI. */
  isGitRepo: boolean;
}

export interface BrowseResult {
  /** Real, absolute path of the listed directory. */
  path: string;
  /** Parent directory, or null when path === sandbox root. */
  parent: string | null;
  entries: BrowseEntry[];
}

export type BrowseErrorCode =
  | 'not_found'
  | 'outside_root'
  | 'not_directory'
  | 'read_failed'
  | 'invalid_name'
  | 'already_exists'
  | 'mkdir_failed';

export class BrowseError extends Error {
  constructor(public code: BrowseErrorCode, message: string) {
    super(message);
    this.name = 'BrowseError';
  }
}

export interface BrowseOptions {
  /** Include entries starting with a dot. Default false. */
  showHidden?: boolean;
}

/**
 * List immediate sub-directories of `requested`, clamped to `root`.
 *
 * - `requested` omitted or empty ⇒ lists the sandbox root.
 * - Relative paths are resolved against the sandbox root (defensive —
 *   the API should already send absolute paths).
 */
export function listDirectory(
  requested: string | null | undefined,
  root: string,
  opts: BrowseOptions = {}
): BrowseResult {
  const { showHidden = false } = opts;
  const target = requested && requested.trim() ? requested.trim() : root;
  const absolute = resolvePath(root, target);

  let real: string;
  try {
    real = realpathSync(absolute);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new BrowseError('not_found', 'Directory does not exist');
    }
    throw new BrowseError('read_failed', e.message);
  }

  if (real !== root && !real.startsWith(root + sep)) {
    throw new BrowseError('outside_root', 'Path is outside the allowed root');
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(real);
  } catch (err) {
    throw new BrowseError('read_failed', (err as Error).message);
  }
  if (!st.isDirectory()) {
    throw new BrowseError('not_directory', 'Path is not a directory');
  }

  let raw: import('node:fs').Dirent[];
  try {
    raw = readdirSync(real, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    throw new BrowseError('read_failed', (err as Error).message);
  }

  const entries: BrowseEntry[] = [];
  for (const d of raw) {
    // Only directories. readdir with withFileTypes returns Dirent; follow
    // symlinks one level so a symlinked directory shows as a directory.
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try {
        isDir = statSync(join(real, d.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    if (!showHidden && d.name.startsWith('.')) continue;
    const isGitRepo = existsSync(join(real, d.name, '.git'));
    entries.push({ name: d.name, isGitRepo });
  }

  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );

  return {
    path: real,
    parent: real === root ? null : dirname(real),
    entries
  };
}

/**
 * Name of a directory-to-be-created. Must match the allowlist —
 * no path separators, no `.`/`..`, no NUL, no leading/trailing
 * whitespace. Length capped at 255 (most filesystems' limit).
 */
const NAME_RE = /^[A-Za-z0-9_\-. ]+$/;

function isValidName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name !== name.trim()) return false;
  return NAME_RE.test(name);
}

/**
 * Create a new sub-directory under `parent`, clamped to `root`.
 *
 * Returns the realpath of the newly created directory. Throws
 * BrowseError for:
 *   - outside_root / not_found / not_directory (via realpath+stat)
 *   - invalid_name (fails allowlist)
 *   - already_exists (target already present)
 *   - mkdir_failed (other mkdir errors — permissions, ENOSPC, etc.)
 */
export function createDirectory(
  parent: string,
  name: string,
  root: string
): string {
  if (!isValidName(name)) {
    throw new BrowseError('invalid_name', 'Invalid directory name');
  }

  // Resolve the parent through realpath + sandbox prefix check first
  // so a symlinked parent that points outside can't be written to.
  let parentReal: string;
  try {
    parentReal = realpathSync(parent);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new BrowseError('not_found', 'Parent directory does not exist');
    }
    throw new BrowseError('read_failed', e.message);
  }
  if (parentReal !== root && !parentReal.startsWith(root + sep)) {
    throw new BrowseError('outside_root', 'Parent is outside the allowed root');
  }
  if (!statSync(parentReal).isDirectory()) {
    throw new BrowseError('not_directory', 'Parent is not a directory');
  }

  const target = join(parentReal, name);
  if (existsSync(target)) {
    throw new BrowseError('already_exists', 'Directory already exists');
  }

  try {
    mkdirSync(target);
  } catch (err) {
    throw new BrowseError('mkdir_failed', (err as Error).message);
  }

  // Realpath again: target may be on a symlinked subtree — we return
  // the canonical path so the client can navigate to it.
  return realpathSync(target);
}
