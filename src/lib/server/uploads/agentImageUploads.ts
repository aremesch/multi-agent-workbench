/**
 * Image-attachment uploads for agent terminals.
 *
 * Pure helper, no SvelteKit imports — driven by the
 * POST /api/agents/[id]/upload-image route. Writes the binary into the
 * agent's worktree at `.maw/uploads/<gen>.<ext>` and ensures a
 * `.maw/.gitignore` (containing `*\n`) is in place so accidental
 * `git add .` doesn't commit screenshots.
 *
 * Why inside the worktree? The relative path that lands in the agent's
 * prompt (`@.maw/uploads/<file>`) is read by the CLI from its own cwd,
 * which is the worktree root. Stable, portable, and the user can clean
 * up by deleting `.maw/`.
 *
 * Why a server-generated filename? We never trust the multipart
 * `file.name` for the on-disk name — that's user-controlled. The
 * generator emits a path-safe `[base36-timestamp]-[6 hex].<ext>` so the
 * `startsWith(dirAbs + sep)` containment guard cannot fail unless this
 * module is misused.
 *
 * Limits and accepted MIMEs match Claude Code's documented constraints
 * (5 MB, PNG/JPEG/GIF/WebP) so a successful upload here is never the
 * thing that surprises the CLI later.
 */

import { randomBytes } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const ALLOWED_MIME = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

/**
 * Configurable cap, defaults to 5 MiB to match Claude Code's per-image
 * limit. Read at module load — not per call — because changing it at
 * runtime is not a real use case and we want the constant to show up in
 * client-side validation messages without a round trip.
 */
export const MAX_BYTES: number = (() => {
  const raw = process.env.MAW_IMAGE_MAX_BYTES;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 5 * 1024 * 1024;
})();

export const UPLOADS_SUBDIR = '.maw/uploads';
const GITIGNORE_REL = '.maw/.gitignore';
const GITIGNORE_BODY = '*\n';

export type ValidationResult =
  | { ok: true; ext: string }
  | { ok: false; code: 'mime' | 'size' };

export function validateUpload(mime: string, size: number): ValidationResult {
  const ext = EXT_BY_MIME[mime];
  if (!ext || !ALLOWED_MIME.has(mime)) return { ok: false, code: 'mime' };
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
    return { ok: false, code: 'size' };
  }
  return { ok: true, ext };
}

/**
 * `[base36-millis]-[6 hex].<ext>`. The hex segment guarantees uniqueness
 * even when two uploads land in the same millisecond; the timestamp
 * prefix keeps `ls .maw/uploads/` chronologically sorted for the user.
 *
 * The output is intentionally kept to `[a-z0-9-.]` — no slashes, no
 * traversal, no path-confusing characters.
 */
export function generateFilename(ext: string): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(3).toString('hex');
  return `${ts}-${rand}.${ext}`;
}

/**
 * Idempotently writes `<wt>/.maw/.gitignore` with a single `*` rule so
 * uploads here never sneak into a `git add .` commit. Skips the write
 * if the file already exists — preserving any rules the user might
 * have edited in by hand.
 */
export async function ensureMawGitignore(worktreePath: string): Promise<void> {
  const dirAbs = resolve(worktreePath, '.maw');
  await mkdir(dirAbs, { recursive: true });
  const giAbs = resolve(worktreePath, GITIGNORE_REL);
  try {
    await access(giAbs);
    return;
  } catch {
    // File missing — create it.
  }
  await writeFile(giAbs, GITIGNORE_BODY, { flag: 'wx' });
}

/**
 * Persist an image into `<wt>/.maw/uploads/` and return both paths.
 * Throws on:
 *   - filesystem failures (mkdir / writeFile)
 *   - the filename containment guard (defensive — filename is
 *     server-generated, so this only triggers if generateFilename is
 *     monkey-patched in tests)
 *
 * MIME is required to be already-validated; the function trusts the
 * caller to have run `validateUpload` first.
 */
export interface WriteAgentImageOpts {
  /**
   * Filename generator override. Production callers leave this unset and
   * get the default `generateFilename`. Tests inject a stub so the
   * containment guard is reachable from unit code.
   */
  genFilename?: (ext: string) => string;
}

export async function writeAgentImage(
  worktreePath: string,
  mime: string,
  bytes: Uint8Array,
  opts: WriteAgentImageOpts = {}
): Promise<{ relativePath: string; absolutePath: string; filename: string }> {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new Error(`unsupported mime: ${mime}`);

  const dirAbs = resolve(worktreePath, UPLOADS_SUBDIR);
  await mkdir(dirAbs, { recursive: true });
  await ensureMawGitignore(worktreePath);

  const gen = opts.genFilename ?? generateFilename;
  const filename = gen(ext);
  const fileAbs = resolve(dirAbs, filename);
  // Belt-and-braces traversal guard. The default generator never
  // produces a path-escaping output, but a custom one might; mirrors
  // the agentPlans.ts pattern.
  if (!fileAbs.startsWith(dirAbs + sep)) {
    throw new Error('invalid_filename');
  }

  await writeFile(fileAbs, bytes, { mode: 0o600 });

  return {
    relativePath: `${UPLOADS_SUBDIR}/${filename}`,
    absolutePath: fileAbs,
    filename
  };
}
