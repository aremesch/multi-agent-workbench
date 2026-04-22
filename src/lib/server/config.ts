/**
 * Runtime configuration.
 *
 * Resolved once at bootstrap; reads env vars with sensible defaults. Anything
 * that reads process.env inside the app should go through getConfig().
 */

import { resolve } from 'node:path';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Minimal .env loader. We intentionally avoid adding the `dotenv` dependency:
 * format is narrow, and SvelteKit dev doesn't populate process.env from .env
 * the way a Next.js or adapter-node prod boot would.
 *
 * Honors `KEY=value`, `KEY="value with spaces"`, skips `#` comments, and
 * never overwrites a variable that's already set in the real process env
 * (so explicit env wins over file env — matches dotenv semantics).
 */
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface MawConfig {
  port: number;
  host: string;
  dataDir: string;
  fifoDir: string;
  worktreeRoot: string;
  migrationsDir: string;
  cliAdaptersDir: string;
  bootstrapUsername: string;
  bootstrapPassword: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  anthropicApiKey: string;
  terminalLogBudgetBytes: number;
  trustProxy: boolean;
  authLogPath: string;
  loginRateLimit: { count: number; windowSeconds: number };
  publicOrigin: string | null;
  isDev: boolean;
}

function parseRateLimit(raw: string | undefined): { count: number; windowSeconds: number } {
  const fallback = { count: 10, windowSeconds: 60 };
  if (!raw) return fallback;
  const m = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return fallback;
  const count = Number(m[1]);
  const windowSeconds = Number(m[2]);
  if (!count || !windowSeconds) return fallback;
  return { count, windowSeconds };
}

let _cfg: MawConfig | null = null;

export function getConfig(): MawConfig {
  if (_cfg) return _cfg;

  const projectRoot = process.cwd();
  // Load .env before we read process.env. Real env still wins.
  loadDotenv(resolve(projectRoot, '.env'));
  const env = process.env;

  _cfg = {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '127.0.0.1',
    dataDir: env.MAW_DATA_DIR ?? `${env.HOME ?? ''}/.local/share/maw-dev`,
    fifoDir: env.MAW_FIFO_DIR ?? '/tmp/maw-fifos',
    worktreeRoot:
      env.MAW_WORKTREE_ROOT ?? `${env.HOME ?? ''}/.local/share/maw-dev/worktrees`,
    migrationsDir: resolve(projectRoot, 'migrations'),
    cliAdaptersDir: resolve(projectRoot, 'cli-adapters'),
    bootstrapUsername: env.MAW_BOOTSTRAP_USERNAME ?? 'admin',
    bootstrapPassword: env.MAW_BOOTSTRAP_PASSWORD ?? 'changeme',
    sessionSecret: env.MAW_SESSION_SECRET ?? 'dev-insecure-replace-me',
    sessionTtlSeconds: 60 * 60 * 24 * 30, // 30 days
    vapidPublicKey: env.MAW_VAPID_PUBLIC_KEY ?? '',
    vapidPrivateKey: env.MAW_VAPID_PRIVATE_KEY ?? '',
    vapidSubject: env.MAW_VAPID_SUBJECT ?? 'mailto:dev@example.com',
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    terminalLogBudgetBytes: Number(env.MAW_TERMINAL_LOG_BYTES ?? 4 * 1024 * 1024),
    trustProxy: env.MAW_TRUST_PROXY === '1',
    authLogPath:
      env.MAW_AUTH_LOG_PATH ??
      resolve(env.MAW_DATA_DIR ?? `${env.HOME ?? ''}/.local/share/maw-dev`, 'auth.log'),
    loginRateLimit: parseRateLimit(env.MAW_LOGIN_RATE_LIMIT),
    publicOrigin: env.MAW_PUBLIC_ORIGIN ?? null,
    isDev: env.NODE_ENV !== 'production'
  };
  return _cfg;
}

let _fsBrowseRoot: string | null = null;

/**
 * Sandbox root for the directory-picker API (`/api/fs/list`).
 *
 * Defaults to the server user's home directory. Resolved through
 * `realpathSync` once per process so that a symlinked `$HOME` doesn't
 * produce false negatives on the prefix check downstream.
 *
 * Deliberately kept module-local (not on `MawConfig`) — this is a
 * picker-only concern; revisit if we ever expose multi-root config.
 */
export function getFsBrowseRoot(): string {
  if (_fsBrowseRoot) return _fsBrowseRoot;
  const raw = process.env.HOME || homedir();
  try {
    _fsBrowseRoot = realpathSync(raw);
  } catch {
    _fsBrowseRoot = raw;
  }
  return _fsBrowseRoot;
}
