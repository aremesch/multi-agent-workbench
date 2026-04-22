import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BrowseError, createDirectory, listDirectory } from './browse.js';

let root: string;
let outside: string;

beforeEach(() => {
  // realpathSync to collapse macOS's /private/var → /var (matches what
  // getFsBrowseRoot would have resolved at process start).
  root = realpathSync(mkdtempSync(join(tmpdir(), 'maw-browse-root-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'maw-browse-outside-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('listDirectory', () => {
  it('lists immediate child directories sorted case-insensitively', () => {
    mkdirSync(join(root, 'Bravo'));
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, 'charlie'));
    writeFileSync(join(root, 'ignored.txt'), 'x');

    const res = listDirectory(root, root);
    expect(res.path).toBe(root);
    expect(res.parent).toBeNull();
    expect(res.entries.map((e) => e.name)).toEqual(['alpha', 'Bravo', 'charlie']);
    expect(res.entries.every((e) => e.isGitRepo === false)).toBe(true);
  });

  it('flags directories that contain a .git entry as git repos', () => {
    const repo = join(root, 'myrepo');
    mkdirSync(repo);
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(root, 'plain'));

    const res = listDirectory(root, root);
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e.isGitRepo]));
    expect(byName['myrepo']).toBe(true);
    expect(byName['plain']).toBe(false);
  });

  it('hides dotfiles by default and reveals them with showHidden', () => {
    mkdirSync(join(root, 'visible'));
    mkdirSync(join(root, '.hidden'));

    const hiddenOff = listDirectory(root, root);
    expect(hiddenOff.entries.map((e) => e.name)).toEqual(['visible']);

    const hiddenOn = listDirectory(root, root, { showHidden: true });
    expect(hiddenOn.entries.map((e) => e.name)).toEqual(['.hidden', 'visible']);
  });

  it('returns parent path when inside a subdirectory', () => {
    const sub = join(root, 'sub');
    mkdirSync(sub);

    const res = listDirectory(sub, root);
    expect(res.path).toBe(sub);
    expect(res.parent).toBe(root);
  });

  it('defaults to the sandbox root when requested path is empty', () => {
    mkdirSync(join(root, 'child'));
    const res = listDirectory('', root);
    expect(res.path).toBe(root);
    expect(res.parent).toBeNull();
    expect(res.entries.map((e) => e.name)).toEqual(['child']);
  });

  it('rejects paths that resolve outside the sandbox root', () => {
    expect(() => listDirectory(outside, root)).toThrow(BrowseError);
    try {
      listDirectory(outside, root);
    } catch (err) {
      expect((err as BrowseError).code).toBe('outside_root');
    }
  });

  it('rejects symlink escapes via realpath resolution', () => {
    // A symlink inside the sandbox that points to a sibling outside it.
    symlinkSync(outside, join(root, 'escape'));
    expect(() => listDirectory(join(root, 'escape'), root)).toThrow(BrowseError);
    try {
      listDirectory(join(root, 'escape'), root);
    } catch (err) {
      expect((err as BrowseError).code).toBe('outside_root');
    }
  });

  it('throws not_found for non-existent paths', () => {
    expect(() => listDirectory(join(root, 'does-not-exist'), root)).toThrow(BrowseError);
    try {
      listDirectory(join(root, 'does-not-exist'), root);
    } catch (err) {
      expect((err as BrowseError).code).toBe('not_found');
    }
  });

  it('throws not_directory when path points to a file', () => {
    const file = join(root, 'file.txt');
    writeFileSync(file, 'data');
    expect(() => listDirectory(file, root)).toThrow(BrowseError);
    try {
      listDirectory(file, root);
    } catch (err) {
      expect((err as BrowseError).code).toBe('not_directory');
    }
  });
});

describe('createDirectory', () => {
  it('creates a new sub-directory under an allowed parent', () => {
    const created = createDirectory(root, 'new-sub', root);
    expect(created).toBe(join(root, 'new-sub'));
    expect(existsSync(created)).toBe(true);
    expect(statSync(created).isDirectory()).toBe(true);
  });

  it('rejects names containing a path separator', () => {
    try {
      createDirectory(root, 'a/b', root);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BrowseError);
      expect((err as BrowseError).code).toBe('invalid_name');
    }
    expect(existsSync(join(root, 'a'))).toBe(false);
  });

  it("rejects '.' and '..' names", () => {
    for (const name of ['.', '..']) {
      try {
        createDirectory(root, name, root);
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as BrowseError).code).toBe('invalid_name');
      }
    }
  });

  it('rejects names with only whitespace or leading/trailing spaces', () => {
    for (const name of ['   ', ' leading', 'trailing ']) {
      try {
        createDirectory(root, name, root);
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as BrowseError).code).toBe('invalid_name');
      }
    }
  });

  it('rejects parents outside the sandbox root', () => {
    try {
      createDirectory(outside, 'child', root);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as BrowseError).code).toBe('outside_root');
    }
  });

  it('rejects symlinked parents that resolve outside the root', () => {
    symlinkSync(outside, join(root, 'escape'));
    try {
      createDirectory(join(root, 'escape'), 'child', root);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as BrowseError).code).toBe('outside_root');
    }
  });

  it('throws already_exists when the target is already present', () => {
    mkdirSync(join(root, 'there'));
    try {
      createDirectory(root, 'there', root);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as BrowseError).code).toBe('already_exists');
    }
  });

  it('throws not_found when parent does not exist', () => {
    try {
      createDirectory(join(root, 'nope'), 'child', root);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as BrowseError).code).toBe('not_found');
    }
  });
});
