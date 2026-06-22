/**
 * Project-memory bookkeeping tests — real persistence on the in-memory SQLite
 * fixture (mock db/index.js), like the queries tests.
 */
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllTables, openMemoryDb } from '../../../../tests/unit/helpers/db.js';

let db: Database.Database | null = null;
vi.mock('../db/index.js', () => ({
  getDb: () => {
    if (!db) throw new Error('test db not initialized');
    return db;
  },
  withTx: <T>(fn: (d: Database.Database) => T): T => db!.transaction(fn)(db!),
  closeDb: () => {}
}));

import {
  insertRepo,
  insertRole,
  insertSupervisorRun,
  insertUser,
  listProjectMemory
} from '../db/queries.js';
import { recordVerdictIssues, renderLessons } from './projectMemory.js';

beforeAll(() => {
  db = openMemoryDb();
});
afterAll(() => {
  db?.close();
  db = null;
});
beforeEach(() => {
  if (db) clearAllTables(db);
  insertUser({ id: 'u1', username: 'u', password_hash: 'h' });
  insertRepo({ id: 'r1', user_id: 'u1', path: '/tmp/r1', origin_url: null, default_branch: 'main' });
  insertRole({
    id: 'role',
    user_id: 'u1',
    name: 'R',
    system_prompt: '',
    cli_kind: 'claude-code',
    default_args_json: '[]',
    tool_config_json: '{}',
    repo_scope_json: '[]'
  });
  // source_run_id is a FK → seed the runs the tests reference.
  for (const id of ['run1', 'run2']) {
    insertSupervisorRun({
      id,
      user_id: 'u1',
      repo_id: 'r1',
      role_id: 'role',
      qc_role_id: 'role',
      title: id,
      plan_md: '',
      phase: 'executing',
      config_json: '{}'
    });
  }
});

describe('recordVerdictIssues', () => {
  it('skips low-severity issues', () => {
    recordVerdictIssues({
      userId: 'u1',
      repoId: 'r1',
      runId: 'run1',
      issues: [{ category: 'style', severity: 'low', detail: 'nit' }]
    });
    expect(listProjectMemory('r1')).toHaveLength(0);
  });

  it('records medium/high issues and increments hit_count on repeat category', () => {
    recordVerdictIssues({
      userId: 'u1',
      repoId: 'r1',
      runId: 'run1',
      issues: [{ category: 'DRY', severity: 'high', detail: 'dup helper' }]
    });
    recordVerdictIssues({
      userId: 'u1',
      repoId: 'r1',
      runId: 'run2',
      issues: [{ category: 'dry', severity: 'medium', detail: 'dup again' }]
    });
    const lessons = listProjectMemory('r1');
    expect(lessons).toHaveLength(1); // same category, case-normalized
    expect(lessons[0]!.category).toBe('dry');
    expect(lessons[0]!.hit_count).toBe(2);
  });
});

describe('renderLessons', () => {
  it('renders active lessons with a recurrence marker and respects minHits', () => {
    recordVerdictIssues({
      userId: 'u1',
      repoId: 'r1',
      runId: 'run1',
      issues: [
        { category: 'security', severity: 'high', detail: 'unsanitized input' },
        { category: 'testing', severity: 'medium', detail: 'no tests' }
      ]
    });
    // bump security to hit_count 2
    recordVerdictIssues({
      userId: 'u1',
      repoId: 'r1',
      runId: 'run2',
      issues: [{ category: 'security', severity: 'high', detail: 'again' }]
    });
    expect(renderLessons('r1')).toHaveLength(2);
    const recurring = renderLessons('r1', 2);
    expect(recurring).toHaveLength(1);
    expect(recurring[0]).toContain('seen 2×');
  });
});
