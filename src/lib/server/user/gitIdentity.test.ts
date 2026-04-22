import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllTables, openMemoryDb } from '../../../../tests/unit/helpers/db.js';

let db: Database.Database | null = null;

vi.mock('../db/index.js', () => ({
  getDb: () => {
    if (!db) throw new Error('test db not initialized');
    return db;
  },
  withTx: <T>(fn: (d: Database.Database) => T): T => {
    if (!db) throw new Error('test db not initialized');
    return db.transaction(fn)(db);
  },
  closeDb: () => {}
}));

import { insertUser } from '../db/queries.js';
import {
  getStoredGitIdentity,
  hasGitIdentity,
  resolveGitIdentity,
  resolveGitIdentityForUser,
  setGitIdentity,
  validateGitIdentity
} from './gitIdentity.js';

beforeAll(() => {
  db = openMemoryDb();
});

afterAll(() => {
  db?.close();
  db = null;
});

beforeEach(() => {
  clearAllTables(db!);
});

function seedUser(id = 'user-1', username = 'alice'): void {
  insertUser({ id, username, password_hash: 'h', must_change_password: false });
}

describe('validateGitIdentity', () => {
  it('accepts plain name + valid email', () => {
    expect(validateGitIdentity('Alice', 'alice@example.com')).toBeNull();
  });

  it.each([
    ['empty name', '', 'alice@example.com', 'nameRequired'],
    ['name with <', 'Bob <bob>', 'b@c.d', 'nameInvalid'],
    ['name with >', 'Bob>', 'b@c.d', 'nameInvalid'],
    ['name too long', 'x'.repeat(101), 'b@c.d', 'nameInvalid'],
    ['empty email', 'Alice', '', 'emailRequired'],
    ['no @', 'Alice', 'alice.example.com', 'emailInvalid'],
    ['no dot', 'Alice', 'alice@example', 'emailInvalid'],
    ['spaces in email', 'Alice', 'alice @example.com', 'emailInvalid'],
    ['< in email', 'Alice', '<alice>@example.com', 'emailInvalid'],
    ['email too long', 'Alice', `${'x'.repeat(250)}@e.co`, 'emailInvalid']
  ])('%s rejected', (_name, n, e, want) => {
    expect(validateGitIdentity(n, e)).toBe(want);
  });

  it('accepts GitHub noreply email format', () => {
    expect(validateGitIdentity('Alice', '12345+alice@users.noreply.github.com')).toBeNull();
  });
});

describe('getStoredGitIdentity / hasGitIdentity', () => {
  it('returns null fields when nothing stored', () => {
    seedUser();
    expect(getStoredGitIdentity('user-1')).toEqual({ name: null, email: null });
    expect(hasGitIdentity('user-1')).toBe(false);
  });

  it('returns null fields when setting has invalid JSON', () => {
    // Simulate corrupted value (direct insert, bypass the setter)
    seedUser();
    db!.prepare(
      `INSERT INTO user_settings (user_id, key, value_json, created_at, updated_at)
       VALUES ('user-1', 'git.authorName', 'not-json', 0, 0)`
    ).run();
    expect(getStoredGitIdentity('user-1').name).toBeNull();
  });

  it('hasGitIdentity is false when only one of the two is set', () => {
    seedUser();
    setGitIdentity('user-1', { name: 'Alice', email: 'a@b.c' });
    expect(hasGitIdentity('user-1')).toBe(true);

    // Wipe the email half directly to simulate partial configuration
    db!.prepare(`DELETE FROM user_settings WHERE user_id = 'user-1' AND key = 'git.authorEmail'`).run();
    expect(hasGitIdentity('user-1')).toBe(false);
  });
});

describe('setGitIdentity round-trip', () => {
  it('persists values through setUserSetting / getUserSetting', () => {
    seedUser();
    setGitIdentity('user-1', { name: 'Alice', email: 'alice@example.com' });
    expect(getStoredGitIdentity('user-1')).toEqual({ name: 'Alice', email: 'alice@example.com' });
    expect(hasGitIdentity('user-1')).toBe(true);
  });

  it('upserts on re-save', () => {
    seedUser();
    setGitIdentity('user-1', { name: 'A', email: 'a@a.aa' });
    setGitIdentity('user-1', { name: 'B', email: 'b@b.bb' });
    expect(getStoredGitIdentity('user-1')).toEqual({ name: 'B', email: 'b@b.bb' });
  });
});

describe('resolveGitIdentity fallback', () => {
  it('falls back to username + synthetic email when both unset', () => {
    seedUser();
    expect(resolveGitIdentity('user-1', 'alice')).toEqual({
      name: 'alice',
      email: 'alice@maw.local'
    });
  });

  it('returns stored values when set', () => {
    seedUser();
    setGitIdentity('user-1', { name: 'Alice Real', email: 'alice@work.com' });
    expect(resolveGitIdentity('user-1', 'alice')).toEqual({
      name: 'Alice Real',
      email: 'alice@work.com'
    });
  });
});

describe('resolveGitIdentityForUser', () => {
  it('resolves identity using stored username from DB', () => {
    seedUser('user-7', 'bob');
    expect(resolveGitIdentityForUser('user-7')).toEqual({
      name: 'bob',
      email: 'bob@maw.local'
    });
  });

  it('throws when user does not exist', () => {
    expect(() => resolveGitIdentityForUser('ghost')).toThrow(/user not found/);
  });
});
