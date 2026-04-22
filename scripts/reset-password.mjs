#!/usr/bin/env node
/**
 * Reset a user's password directly in the MAW SQLite DB.
 *
 * Emergency-only tool for local dev / self-hosted recovery — the normal flow
 * is the /settings UI's "change password" form. Rehashes with the same
 * argon2id parameters the app uses, clears `must_change_password`, and
 * bumps `password_updated_at`.
 *
 * Usage:
 *
 *   node scripts/reset-password.mjs --username <name> --password <plain> \
 *     [--db <path>]
 *
 *   # Example (local dev):
 *   node scripts/reset-password.mjs --username ar --password Alex1234
 *
 *   # Example (custom DB):
 *   node scripts/reset-password.mjs --username ar --password secret \
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
    if (key === '--username') {
      out.username = val;
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
    'Usage: node scripts/reset-password.mjs --username <name> --password <plain> [--db <path>]'
  );
}

const args = parseArgs(argv);

if (args.help || !args.username || !args.password) {
  printUsage();
  exit(args.help ? 0 : 1);
}

const dbPath =
  args.db ?? (env.MAW_DATA_DIR ? join(env.MAW_DATA_DIR, 'maw.db') : null);
if (!dbPath) {
  console.error(
    'No DB path. Set MAW_DATA_DIR or pass --db <path>.'
  );
  exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  exit(1);
}

// Must match src/lib/server/auth/password.ts. Keep these in sync.
const newHash = await hash(args.password, {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1
});

const db = new Database(dbPath);
const now = Math.floor(Date.now() / 1000);
const info = db
  .prepare(
    'UPDATE users SET password_hash = ?, password_updated_at = ?, updated_at = ?, must_change_password = 0 WHERE username = ?'
  )
  .run(newHash, now, now, args.username);
db.close();

if (info.changes === 0) {
  console.error(`No user found with username '${args.username}'.`);
  exit(1);
}

console.log(`Password reset for user '${args.username}' (${dbPath}).`);
