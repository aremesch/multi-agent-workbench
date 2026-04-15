/**
 * Boot-time migration runner.
 *
 * Format per plan §Drizzle migration readiness, rule 4-5:
 *   - migrations/NNN_*.sql files, pure SQL only
 *   - tracking table is __drizzle_migrations (Drizzle's default format)
 *     with columns (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER)
 *
 * The hash we use is the sha256 of the SQL file contents; Drizzle uses the
 * same scheme so we can hand the history over without touching rows.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getDb } from './index.js';
import { getConfig } from '../config.js';

interface MigrationRow {
  id: number;
  hash: string;
  created_at: number;
}

export function runMigrations(): { applied: number; total: number } {
  const db = getDb();
  const cfg = getConfig();

  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  const files = readdirSync(cfg.migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const applied = db
    .prepare<[], MigrationRow>('SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id')
    .all();
  const appliedHashes = new Set(applied.map((r) => r.hash));

  let newlyApplied = 0;
  const now = Math.floor(Date.now() / 1000);

  const insertMigration = db.prepare<[string, number]>(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)'
  );

  for (const file of files) {
    const sql = readFileSync(join(cfg.migrationsDir, file), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    if (appliedHashes.has(hash)) continue;

    // SQLite refuses `DROP TABLE` on any table referenced by an FK when
    // `foreign_keys=ON`, and the pragma can't be toggled inside a tx — so
    // we disable FKs around the transaction per the SQLite 12-step rebuild
    // recipe. Migrations still run atomically; if one fails, the tx rolls
    // back and FKs are restored in the finally.
    const fkWasOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
    if (fkWasOn) db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(sql);
        insertMigration.run(hash, now);
      });
      tx();
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
    newlyApplied++;
  }

  return { applied: newlyApplied, total: files.length };
}
