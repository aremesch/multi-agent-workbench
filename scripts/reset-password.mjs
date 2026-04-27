#!/usr/bin/env node
/**
 * Reset a user's password directly in the MAW SQLite DB.
 *
 * Emergency-only tool for local dev / self-hosted recovery — the normal flow
 * is the /settings UI's "change password" form. Rehashes with the same
 * argon2id parameters the app uses, clears `must_change_password`, and
 * bumps `updatedAt` on the better-auth `user` table.
 *
 * Usage:
 *
 *   node scripts/reset-password.mjs --email <email> --password <plain> \
 *     [--db <path>]
 *
 *   # Example (local dev):
 *   node scripts/reset-password.mjs --email ar@maw.local --password Alex1234
 *
 *   # Example (custom DB):
 *   node scripts/reset-password.mjs --email ar@maw.local --password secret \
 *     --db /var/lib/maw/maw.db
 *
 * The DB path defaults to `$MAW_DATA_DIR/maw.db` (reading `.env` is not
 * automatic — either export `MAW_DATA_DIR` or pass `--db` explicitly).
 *
 * Must be run from the repo root so `@node-rs/argon2` and `better-sqlite3`
 * resolve from node_modules.
 */

import { hash } from '@node-rs/argon2';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';

function parseArgs(args) {
  const out = {};
  for (let i = 2; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    if (key === '--email') {
      out.email = val;
      i++;
    } else if (key === '--password') {
      out.password = val;
      i++;
    } else if (key === '--db') {
      out.db = val;
      i++;
    } else if (key === '--help' || key === '-h') {
      out.help = true;
    } else {
      console.error(`Unknown argument: ${key}`);
      out.help = true;
    }
  }
  return out;
}

function printUsage() {
  console.error(
    'Usage: node scripts/reset-password.mjs --email <email> --password <plain> [--db <path>]'
  );
}

const args = parseArgs(argv);

if (args.help || !args.email || !args.password) {
  printUsage();
  exit(args.help ? 0 : 1);
}

const dbPath =
  args.db ?? (env.MAW_DATA_DIR ? join(env.MAW_DATA_DIR, 'maw.db') : null);
if (!dbPath) {
  console.error('No DB path. Set MAW_DATA_DIR or pass --db <path>.');
  exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  exit(1);
}

// Must match argon2Options in src/lib/server/auth/betterAuth.ts. Keep in sync.
const newHash = await hash(args.password, {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1
});

const db = new Database(dbPath);
const now = Math.floor(Date.now() / 1000);

// Resolve the user id from the better-auth `user` table by email.
const userRow = db.prepare('SELECT id FROM user WHERE email = ?').get(args.email);
if (!userRow) {
  console.error(`No user found with email '${args.email}'.`);
  db.close();
  exit(1);
}

db.transaction(() => {
  // Update password in better-auth account table (credential provider).
  db.prepare(
    "UPDATE account SET password = ? WHERE userId = ? AND providerId = 'credential'"
  ).run(newHash, userRow.id);

  // Bump updatedAt on the better-auth user row.
  db.prepare('UPDATE user SET updatedAt = ? WHERE id = ?').run(now, userRow.id);

  // Clear must_change_password on the legacy users table (same id).
  db.prepare(
    'UPDATE users SET must_change_password = 0, updated_at = ? WHERE id = ?'
  ).run(now, userRow.id);
})();

db.close();

console.log(`Password reset for '${args.email}' (${dbPath}).`);
