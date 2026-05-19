/**
 * Location-agnostic image-upload core: accepted MIMEs, the size cap, the
 * validator and the path-safe filename generator.
 *
 * Extracted from `agentImageUploads.ts` so the agent paste-into-terminal
 * flow and the queued-task attachment flow share one definition of "what
 * is an acceptable image and what do we call it on disk" — without the
 * task flow having to import worktree-specific helpers. `agentImageUploads`
 * re-exports these names so its existing importers and tests are unchanged.
 *
 * No SvelteKit / fs-location imports here on purpose: this module only
 * knows about bytes, MIME types and filenames.
 */

import { randomBytes } from 'node:crypto';

export const ALLOWED_MIME = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
]);

export const EXT_BY_MIME: Record<string, string> = {
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
 * prefix keeps the uploads directory chronologically sorted for the user.
 *
 * The output is intentionally kept to `[a-z0-9-.]` — no slashes, no
 * traversal, no path-confusing characters.
 */
export function generateFilename(ext: string): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(3).toString('hex');
  return `${ts}-${rand}.${ext}`;
}
