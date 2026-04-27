-- Multi-Agent Workbench — better-auth tables (v0.2)
--
-- Switches login/sessions from the hand-rolled custom auth (sessions table +
-- users.password_hash + ULID session ids) to better-auth, which owns its own
-- four canonical tables: user, session, account, verification. Column names
-- are camelCase per better-auth's schema definitions (see
-- node_modules/@better-auth/core/dist/db/schema/*.mjs).
--
-- The legacy `users` snake_case table stays as the FK anchor for ~30 domain
-- tables (projects.user_id, repos.user_id, agents.user_id, …). We keep
-- users.id and user.id byte-for-byte equal so existing FKs keep resolving.
-- A future migration may collapse the two into one; this one stays small.
--
-- The legacy `sessions` table is dropped — better-auth owns sessions now.
-- Existing rows are throwaway login state; users will sign in again.
--
-- Per-user note: argon2id password hashes are migrated into account.password
-- under provider 'credential'. The betterAuth() init plugs @node-rs/argon2
-- in as the custom hash/verify so existing passwords keep verifying.

-- ---------- better-auth canonical tables ----------

CREATE TABLE user (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image         TEXT,
  createdAt     INTEGER NOT NULL,
  updatedAt     INTEGER NOT NULL
);

CREATE TABLE session (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token     TEXT NOT NULL UNIQUE,
  expiresAt INTEGER NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX idx_session_userId ON session(userId);
CREATE INDEX idx_session_token ON session(token);

CREATE TABLE account (
  id                    TEXT PRIMARY KEY,
  userId                TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accountId             TEXT NOT NULL,
  providerId            TEXT NOT NULL,
  accessToken           TEXT,
  refreshToken          TEXT,
  accessTokenExpiresAt  INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope                 TEXT,
  idToken               TEXT,
  password              TEXT,
  createdAt             INTEGER NOT NULL,
  updatedAt             INTEGER NOT NULL
);
CREATE INDEX idx_account_userId ON account(userId);

CREATE TABLE verification (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expiresAt  INTEGER NOT NULL,
  createdAt  INTEGER NOT NULL,
  updatedAt  INTEGER NOT NULL
);
CREATE INDEX idx_verification_identifier ON verification(identifier);

-- ---------- copy existing single user into better-auth tables ----------
-- email = `<username>@maw.local` — preserves the same identity post-migration
-- while satisfying better-auth's email-required schema. emailVerified=1
-- sidesteps the email-verification flow we don't use.

INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
SELECT
  id,
  username,
  username || '@maw.local',
  1,
  created_at,
  updated_at
FROM users
WHERE NOT EXISTS (SELECT 1 FROM user WHERE user.id = users.id);

-- credential account row: better-auth stores the password hash here, not on
-- the user row. accountId = userId is the convention for credential accounts
-- (no external provider account to track).

INSERT INTO account (id, userId, accountId, providerId, password, createdAt, updatedAt)
SELECT
  id || '-cred',
  id,
  id,
  'credential',
  password_hash,
  created_at,
  updated_at
FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM account WHERE account.userId = users.id AND account.providerId = 'credential'
);

-- ---------- drop legacy sessions table ----------

DROP INDEX IF EXISTS idx_sessions_user;
DROP INDEX IF EXISTS idx_sessions_expires;
DROP TABLE IF EXISTS sessions;
