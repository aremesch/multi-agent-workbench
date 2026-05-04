import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALLOWED_MIME,
  MAX_BYTES,
  UPLOADS_SUBDIR,
  ensureMawGitignore,
  generateFilename,
  validateUpload,
  writeAgentImage
} from './agentImageUploads';

describe('validateUpload', () => {
  it.each([...ALLOWED_MIME])('accepts %s', (mime) => {
    const r = validateUpload(mime, 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ext).toMatch(/^(png|jpg|gif|webp)$/);
  });

  it.each(['image/svg+xml', 'image/bmp', 'text/plain', 'application/octet-stream', ''])(
    'rejects %s',
    (mime) => {
      expect(validateUpload(mime, 100)).toEqual({ ok: false, code: 'mime' });
    }
  );

  it('rejects zero-byte uploads', () => {
    expect(validateUpload('image/png', 0)).toEqual({ ok: false, code: 'size' });
  });

  it('rejects oversized uploads', () => {
    expect(validateUpload('image/png', MAX_BYTES + 1)).toEqual({ ok: false, code: 'size' });
  });

  it('accepts an upload at exactly MAX_BYTES', () => {
    expect(validateUpload('image/png', MAX_BYTES)).toEqual({ ok: true, ext: 'png' });
  });

  it('rejects negative or non-finite sizes', () => {
    expect(validateUpload('image/png', -1)).toEqual({ ok: false, code: 'size' });
    expect(validateUpload('image/png', Number.NaN)).toEqual({ ok: false, code: 'size' });
    expect(validateUpload('image/png', Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      code: 'size'
    });
  });

  it('jpeg → jpg extension', () => {
    const r = validateUpload('image/jpeg', 100);
    expect(r).toEqual({ ok: true, ext: 'jpg' });
  });
});

describe('generateFilename', () => {
  it('matches the safe pattern', () => {
    const name = generateFilename('png');
    expect(name).toMatch(/^[0-9a-z]+-[0-9a-f]{6}\.png$/);
  });

  it('two consecutive calls do not collide', () => {
    const a = generateFilename('png');
    const b = generateFilename('png');
    expect(a).not.toBe(b);
  });

  it('preserves the requested extension', () => {
    expect(generateFilename('webp').endsWith('.webp')).toBe(true);
    expect(generateFilename('jpg').endsWith('.jpg')).toBe(true);
  });

  it('never contains path separators or traversal segments', () => {
    for (let i = 0; i < 50; i++) {
      const name = generateFilename('png');
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toContain('..');
    }
  });
});

describe('ensureMawGitignore', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'maw-img-test-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('creates `.maw/.gitignore` with `*\\n` on first call', async () => {
    await ensureMawGitignore(scratch);
    const body = readFileSync(join(scratch, '.maw', '.gitignore'), 'utf8');
    expect(body).toBe('*\n');
  });

  it('is idempotent — second call leaves the file untouched', async () => {
    await ensureMawGitignore(scratch);
    const giAbs = join(scratch, '.maw', '.gitignore');
    // Backdate the mtime so an unintended rewrite would bump it.
    const oldMs = Date.now() - 60_000;
    utimesSync(giAbs, oldMs / 1000, oldMs / 1000);
    const before = statSync(giAbs).mtimeMs;
    await ensureMawGitignore(scratch);
    const after = statSync(giAbs).mtimeMs;
    expect(after).toBe(before);
  });
});

describe('writeAgentImage', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'maw-img-test-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('writes the bytes and returns sane paths', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await writeAgentImage(scratch, 'image/png', bytes);

    expect(out.relativePath.startsWith(UPLOADS_SUBDIR + '/')).toBe(true);
    expect(out.relativePath.endsWith('.png')).toBe(true);
    expect(out.absolutePath.startsWith(scratch)).toBe(true);
    expect(out.filename).toMatch(/^[0-9a-z]+-[0-9a-f]{6}\.png$/);

    const onDisk = readFileSync(out.absolutePath);
    expect(Array.from(onDisk)).toEqual([1, 2, 3, 4, 5]);
  });

  it('writes mode 0o600 (owner-only)', async () => {
    const out = await writeAgentImage(scratch, 'image/png', new Uint8Array([0]));
    const mode = statSync(out.absolutePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the .gitignore alongside the upload', async () => {
    await writeAgentImage(scratch, 'image/png', new Uint8Array([0]));
    const body = readFileSync(join(scratch, '.maw', '.gitignore'), 'utf8');
    expect(body).toBe('*\n');
  });

  it('extension matches the MIME', async () => {
    const a = await writeAgentImage(scratch, 'image/jpeg', new Uint8Array([0]));
    expect(a.relativePath.endsWith('.jpg')).toBe(true);
    const b = await writeAgentImage(scratch, 'image/webp', new Uint8Array([0]));
    expect(b.relativePath.endsWith('.webp')).toBe(true);
    const c = await writeAgentImage(scratch, 'image/gif', new Uint8Array([0]));
    expect(c.relativePath.endsWith('.gif')).toBe(true);
  });

  it('throws on unsupported MIME (defense — caller should pre-validate)', async () => {
    await expect(
      writeAgentImage(scratch, 'image/svg+xml', new Uint8Array([0]))
    ).rejects.toThrow(/unsupported mime/);
  });

  it('rejects a path-escaping filename via the containment guard', async () => {
    await expect(
      writeAgentImage(scratch, 'image/png', new Uint8Array([0]), {
        genFilename: () => '../escape.png'
      })
    ).rejects.toThrow(/invalid_filename/);
  });

  it('also rejects an absolute-path filename via the containment guard', async () => {
    await expect(
      writeAgentImage(scratch, 'image/png', new Uint8Array([0]), {
        genFilename: () => '/etc/escape.png'
      })
    ).rejects.toThrow(/invalid_filename/);
  });
});
