/**
 * Test helper for DB-backed unit tests. Implementation lands in Phase 2
 * (DB layer). Shape is locked now so Phase 2 callers can be written
 * against a stable signature.
 */
import type Database from 'better-sqlite3';

/**
 * Open a fresh in-memory SQLite database with all project migrations
 * applied, ready to use as a test fixture.
 *
 * Each call returns an independent DB — no cross-test state.
 *
 * TODO(phase-2): implement via `better-sqlite3` + `runMigrations`
 * from `src/lib/server/db/migrate.ts`, running every SQL file in
 * `migrations/` against the handle before returning it.
 */
export function openMemoryDb(): Database.Database {
  throw new Error('openMemoryDb: not implemented until Phase 2 (DB layer tests)');
}
