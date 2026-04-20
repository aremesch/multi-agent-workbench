import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterRegistry } from './AdapterRegistry.js';

const FIXTURES_DIR = join(process.cwd(), 'tests/unit/fixtures/adapters');

/**
 * Create a scratch dir for per-test fixtures. Returned alongside a
 * `write(name, contents)` helper so tests don't have to deal with paths.
 */
function scratchDir(): {
  dir: string;
  write: (name: string, contents: string) => void;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'maw-adapter-reg-'));
  return {
    dir,
    write: (name, contents) => writeFileSync(join(dir, name), contents, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

describe('AdapterRegistry', () => {
  describe('loadAll — happy path using tests/unit/fixtures/adapters', () => {
    it('loads every .jsonc fixture and exposes each kind via has() / list()', () => {
      const reg = new AdapterRegistry(FIXTURES_DIR);
      const result = reg.loadAll();
      expect(result.loaded).toBeGreaterThanOrEqual(2);
      expect(result.errors).toEqual([]);
      expect(reg.has('fixture-one')).toBe(true);
      expect(reg.has('fixture-two')).toBe(true);
      const kinds = reg.list().map((e) => e.kind);
      expect(kinds).toContain('fixture-one');
      expect(kinds).toContain('fixture-two');
    });

    it('create(kind) returns a fresh ConfigDrivenAdapter instance each call', () => {
      const reg = new AdapterRegistry(FIXTURES_DIR);
      reg.loadAll();
      const a = reg.create('fixture-one');
      const b = reg.create('fixture-one');
      expect(a).not.toBe(b);
      expect(a.kind).toBe('fixture-one');
    });

    it('create throws on unknown kind', () => {
      const reg = new AdapterRegistry(FIXTURES_DIR);
      reg.loadAll();
      expect(() => reg.create('not-a-real-kind')).toThrow(/unknown cli_kind/);
    });

    it('list exposes displayName and optionalArgs', () => {
      const reg = new AdapterRegistry(FIXTURES_DIR);
      reg.loadAll();
      const entries = reg.list();
      const one = entries.find((e) => e.kind === 'fixture-one')!;
      expect(one.displayName).toBe('Fixture One');
      expect(Array.isArray(one.optionalArgs)).toBe(true);
    });
  });

  describe('loadAll — error paths', () => {
    let scratch: ReturnType<typeof scratchDir>;

    beforeEach(() => {
      scratch = scratchDir();
    });

    afterEach(() => {
      scratch.cleanup();
    });

    it('returns an error entry when the dir does not exist', () => {
      const reg = new AdapterRegistry(join(scratch.dir, 'does-not-exist'));
      const result = reg.loadAll();
      expect(result.loaded).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/cli-adapters dir not found/);
    });

    it('returns loaded=0 + no errors for an empty dir', () => {
      const reg = new AdapterRegistry(scratch.dir);
      const result = reg.loadAll();
      expect(result).toEqual({ loaded: 0, errors: [] });
    });

    it('reports malformed JSONC with the file name in the error', () => {
      scratch.write('broken.jsonc', '{ unquoted: "value", ');
      const reg = new AdapterRegistry(scratch.dir);
      const result = reg.loadAll();
      expect(result.loaded).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('broken.jsonc');
      expect(result.errors[0]).toMatch(/JSONC parse error/);
    });

    it('reports zod validation failure with the file name', () => {
      scratch.write(
        'schema-bad.jsonc',
        JSON.stringify({
          // missing required `kind`
          displayName: 'X',
          spawn: { command: 'x' },
          input: {}
        })
      );
      const reg = new AdapterRegistry(scratch.dir);
      const result = reg.loadAll();
      expect(result.loaded).toBe(0);
      expect(result.errors[0]).toContain('schema-bad.jsonc');
      expect(result.errors[0]).toMatch(/schema validation failed/);
    });

    it('flags duplicate kinds — keeps the first, reports the second', () => {
      const payload = JSON.stringify({
        kind: 'dup',
        displayName: 'Dup',
        spawn: { command: 'x' },
        input: {}
      });
      scratch.write('a.jsonc', payload);
      scratch.write('b.jsonc', payload);
      const reg = new AdapterRegistry(scratch.dir);
      const result = reg.loadAll();
      expect(result.loaded).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/duplicate adapter kind 'dup'/);
      expect(reg.has('dup')).toBe(true);
    });

    it('rejects invalid regex in a pattern (caught at load, not at run time)', () => {
      scratch.write(
        'bad-regex.jsonc',
        JSON.stringify({
          kind: 'x',
          displayName: 'X',
          spawn: { command: 'x' },
          input: {},
          patterns: [{ id: 'p', kind: 'working', regex: '(unclosed' }]
        })
      );
      const reg = new AdapterRegistry(scratch.dir);
      const result = reg.loadAll();
      expect(result.loaded).toBe(0);
      expect(result.errors[0]).toMatch(/invalid regex in pattern 'p'/);
    });

    it('continues loading after one file fails', () => {
      scratch.write('broken.jsonc', '{ not json');
      scratch.write(
        'good.jsonc',
        JSON.stringify({
          kind: 'good',
          displayName: 'Good',
          spawn: { command: 'x' },
          input: {}
        })
      );
      const reg = new AdapterRegistry(scratch.dir);
      const result = reg.loadAll();
      expect(result.loaded).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(reg.has('good')).toBe(true);
    });
  });

  describe('accepts real cli-adapters/*.jsonc (regression smoke)', () => {
    it('every shipped adapter descriptor passes validation', () => {
      // Keeps someone from accidentally landing a jsonc that ships broken.
      const reg = new AdapterRegistry(join(process.cwd(), 'cli-adapters'));
      const result = reg.loadAll();
      expect(result.errors).toEqual([]);
      expect(result.loaded).toBeGreaterThan(0);
    });
  });

  describe('jsonc comments and trailing commas', () => {
    let scratch: ReturnType<typeof scratchDir>;

    beforeEach(() => {
      scratch = scratchDir();
    });

    afterEach(() => {
      scratch.cleanup();
    });

    it('accepts // comments and trailing commas', () => {
      scratch.write(
        'with-comments.jsonc',
        `{
          // a line comment
          "kind": "cm",
          "displayName": "Cm",
          "spawn": { "command": "x", "args": ["--x", ] },
          "input": {},
        }`
      );
      const reg = new AdapterRegistry(scratch.dir);
      const result = reg.loadAll();
      expect(result.errors).toEqual([]);
      expect(reg.has('cm')).toBe(true);
    });
  });
});

// Keep the fixture files referenced below linked from this file so a
// future `Unused file` lint doesn't scrub them.
void readFileSync;
void mkdirSync;
