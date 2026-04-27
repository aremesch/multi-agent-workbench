import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock must be declared BEFORE imports of migrate.ts. The factory returns
// closures over `db`, which is reassigned per test via beforeEach — the
// closures see the current value at call time, not at factory time.
let db: Database.Database | null = null;

vi.mock('./index.js', () => ({
  getDb: () => {
    if (!db) throw new Error('test db not initialized');
    return db;
  },
  // migrate.ts doesn't use withTx/closeDb, but export the full shape so
  // the module type-checks.
  withTx: <T>(fn: (d: Database.Database) => T): T => {
    if (!db) throw new Error('test db not initialized');
    return db.transaction(fn)(db);
  },
  closeDb: () => {}
}));

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

vi.mock('../config.js', () => ({
  getConfig: () => ({ migrationsDir: MIGRATIONS_DIR })
}));

import { runMigrations } from './migrate.js';

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('runMigrations', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('applies every migration on a fresh DB', () => {
    const files = migrationFiles();
    const result = runMigrations();
    expect(result.applied).toBe(files.length);
    expect(result.total).toBe(files.length);
  });

  it('creates the __drizzle_migrations tracking table', () => {
    runMigrations();
    const row = db!
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`)
      .get();
    expect(row?.name).toBe('__drizzle_migrations');
  });

  it('records one tracking row per applied migration with the file SHA-256', () => {
    runMigrations();
    const hashes = db!
      .prepare<[], { hash: string }>('SELECT hash FROM __drizzle_migrations ORDER BY id')
      .all()
      .map((r) => r.hash);

    const expected = migrationFiles().map((f) =>
      sha256(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    );
    expect(hashes.sort()).toEqual(expected.sort());
  });

  it('is idempotent — a second run applies 0 migrations', () => {
    runMigrations();
    const second = runMigrations();
    expect(second.applied).toBe(0);
    expect(second.total).toBe(migrationFiles().length);
  });

  it('creates the core schema tables (users, agents, auth_events, better-auth)', () => {
    runMigrations();
    const names = new Set(
      db!
        .prepare<
          [],
          { name: string }
        >(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all()
        .map((r) => r.name)
    );
    expect(names.has('users')).toBe(true);
    expect(names.has('agents')).toBe(true);
    // Landed by migration 005.
    expect(names.has('auth_events')).toBe(true);
    // Landed by migration 002.
    expect(names.has('user_settings')).toBe(true);
    // Landed by migration 007 — better-auth's canonical tables.
    // The legacy `sessions` table is dropped by the same migration.
    expect(names.has('user')).toBe(true);
    expect(names.has('session')).toBe(true);
    expect(names.has('account')).toBe(true);
    expect(names.has('verification')).toBe(true);
    expect(names.has('sessions')).toBe(false);
  });

  it('restores FKs to ON after the FK-pragma dance', () => {
    runMigrations();
    expect(db!.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('leaves FKs OFF when caller had them off before entry', () => {
    // The runner only touches FKs if they were ON; if off, leave off.
    db!.pragma('foreign_keys = OFF');
    runMigrations();
    expect(db!.pragma('foreign_keys', { simple: true })).toBe(0);
  });

  it('lands migration 003 — agents.cli_session_id column exists', () => {
    runMigrations();
    const cols = db!
      .prepare<[], { name: string }>('PRAGMA table_info(agents)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('cli_session_id');
  });

  it('lands migration 004 — repos.project_id is nullable and default_branch is on repos', () => {
    runMigrations();
    const cols = db!
      .prepare<[], { name: string; notnull: number }>('PRAGMA table_info(repos)')
      .all();
    const projectIdCol = cols.find((c) => c.name === 'project_id');
    expect(projectIdCol).toBeDefined();
    expect(projectIdCol!.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'default_branch')).toBeDefined();
  });

  it('rolls back a failing migration — tracking table is unchanged', () => {
    // Pre-populate a table name that collides with what migration 001 creates
    // so the first migration's `CREATE TABLE users` throws. The runner should
    // leave __drizzle_migrations empty and bubble the error.
    db!.exec(`CREATE TABLE users (id TEXT PRIMARY KEY)`);

    expect(() => runMigrations()).toThrow();

    const count = db!
      .prepare<
        [],
        { n: number }
      >('SELECT COUNT(*) AS n FROM __drizzle_migrations')
      .get();
    expect(count?.n).toBe(0);
  });
});
