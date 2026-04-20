/**
 * Test helper for filesystem-backed unit tests. Implementation lands
 * in Phase 6 (impure server seams — WorktreeManager, FifoStreamer).
 * Shape is locked now so callers can be written against a stable
 * signature.
 */

/**
 * Run `fn` inside a fresh temp directory created via `fs.mkdtempSync`,
 * then clean it up on completion (including on throw).
 *
 * TODO(phase-6): implement via `node:fs.mkdtempSync(join(os.tmpdir(),
 * 'maw-test-'))` + try/finally rm.
 */
export async function withTempDir<T>(
  _fn: (dir: string) => T | Promise<T>
): Promise<T> {
  throw new Error('withTempDir: not implemented until Phase 6 (fs-backed seams)');
}
