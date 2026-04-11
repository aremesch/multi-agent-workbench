/**
 * SQLite connection singleton.
 *
 * Per the plan (§Drizzle migration readiness, rule 1), this module and
 * queries.ts are the ONLY places that import better-sqlite3 or build SQL.
 * Routes, supervisors, adapters, etc. call typed helpers in queries.ts.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from '../config.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const cfg = getConfig();
  const dbPath = `${cfg.dataDir}/maw.db`;
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  _db = db;
  return db;
}

/**
 * Transaction wrapper. Callers pass a function that receives the db handle;
 * this mirrors Drizzle's `db.transaction(tx => ...)` shape so the eventual
 * migration is mechanical. Queries inside the transaction still go through
 * queries.ts — the handle arg is just to satisfy the type signature.
 */
export function withTx<T>(fn: (db: Database.Database) => T): T {
  const db = getDb();
  const tx = db.transaction(fn);
  return tx(db);
}

/** Testing / shutdown only. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
