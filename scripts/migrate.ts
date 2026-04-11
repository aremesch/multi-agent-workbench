/**
 * Standalone migration runner. Used by `pnpm migrate` or CI jobs that want
 * to pre-initialize the DB without booting the whole app.
 *
 *   pnpm migrate
 */

import { runMigrations } from '../src/lib/server/db/migrate.js';

const result = runMigrations();
console.log(`migrations: ${result.applied}/${result.total} applied`);
