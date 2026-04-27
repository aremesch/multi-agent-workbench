/**
 * Test helper for DB-backed unit tests.
 *
 * Every DB test file mocks `src/lib/server/db/index.js` with a factory
 * that hands out an in-memory SQLite handle created here. That keeps
 * the real connection singleton (which reads config + opens a file)
 * untouched in tests.
 */
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Create a fresh `:memory:` SQLite DB with every `migrations/*.sql`
 * applied in file-name order, mirroring what `runMigrations()` does in
 * production but without the hash tracking table (which would fail the
 * idempotency check in tests that exercise the runner itself).
 *
 * Each call returns an independent DB — no cross-test state.
 */
export function openMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  const migrationsDir = join(process.cwd(), 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.exec(sql);
  }
  return db;
}

/**
 * Tables declared by migrations, in reverse FK-dependency order so a
 * straight `DELETE FROM` loop works even with FKs on.
 */
export const TABLES_IN_TEARDOWN_ORDER = [
  'llm_oversight_verdicts',
  'push_subscriptions',
  'alerts',
  'messages',
  'events',
  'terminal_log',
  'tasks',
  'agent_runs',
  'agents',
  'worktrees',
  'roles',
  'repos',
  'projects',
  'user_settings',
  // better-auth tables — drop before legacy `users` so userId FKs cascade cleanly
  'verification',
  'account',
  'session',
  'user',
  'auth_events',
  'users'
] as const;

/**
 * Wipe every row from every table. Preserves schema and the cached
 * prepared statements in `queries.ts`. FKs are toggled off around the
 * wipe so we don't have to worry about row order.
 */
export function clearAllTables(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of TABLES_IN_TEARDOWN_ORDER) {
      // Some tables may not exist in migration-runner tests that stop
      // partway through the migration set; swallow the error.
      try {
        db.prepare(`DELETE FROM ${table}`).run();
      } catch {
        /* table missing — skip */
      }
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
