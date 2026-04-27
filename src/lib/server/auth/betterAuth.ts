/**
 * better-auth instance singleton.
 *
 * Owns sign-in, sign-out, password change, session storage. Replaces the
 * hand-rolled cookie-session + argon2 stack. Wires to:
 *   - the existing better-sqlite3 handle from getDb()
 *   - @node-rs/argon2 as the password hasher (preserves migrated hashes)
 *
 * Cookie forwarding is intentionally NOT done via the `sveltekitCookies`
 * plugin: that plugin imports `getRequestEvent` from `$app/server`, a
 * SvelteKit-only virtual alias. We bundle this module twice — once in
 * SvelteKit's chunks (where the alias resolves) and once in build/server.js
 * via esbuild (where it does not). Doing cookie forwarding manually in the
 * /login + /account + /logout actions via `forwardCookiesFromResponse`
 * keeps both bundles working without a SvelteKit alias dependency.
 *
 * Single-user constraints:
 *   - emailAndPassword.disableSignUp = true   → no /sign-up endpoint
 *   - no socialProviders                      → no OAuth
 *   - no emailVerification config              → no /verify-email loop
 */

import { betterAuth } from 'better-auth';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import type { Cookies } from '@sveltejs/kit';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';

const argon2Options = {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1
};

const cfg = getConfig();
const rl = cfg.loginRateLimit;

export const auth = betterAuth({
  appName: 'maw',
  database: getDb(),

  // Fall back to the legacy MAW_SESSION_SECRET so existing deployments don't
  // break before BETTER_AUTH_SECRET is set in .env. Better-auth picks up
  // process.env.BETTER_AUTH_SECRET on its own when secret is omitted.
  secret: process.env.BETTER_AUTH_SECRET || cfg.sessionSecret,

  baseURL: cfg.publicOrigin || undefined,

  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 8,
    autoSignIn: false,
    password: {
      hash: (password) => argon2Hash(password, argon2Options),
      verify: ({ hash, password }) => argon2Verify(hash, password)
    }
  },

  // Always-on rate limit on the credential sign-in path. Better-auth's
  // default only enables in production and applies app-wide; we want the
  // 10/60s budget on /sign-in/email regardless of NODE_ENV (dev abuse +
  // e2e harness still need the limiter active).
  rateLimit: {
    enabled: true,
    window: rl.windowSeconds,
    max: rl.count,
    customRules: {
      '/sign-in/email': { window: rl.windowSeconds, max: rl.count }
    }
  },

  session: {
    expiresIn: cfg.sessionTtlSeconds
  },

  advanced: {
    cookies: {
      // Keep the historic cookie name so the WS hub's expectations don't
      // shift and existing browser tabs keep their session through the
      // cutover (the cookie value itself becomes invalid because the old
      // sessions table is dropped, but the name stays).
      session_token: { name: 'maw_session' }
    },
    useSecureCookies: !cfg.isDev,
    defaultCookieAttributes: { sameSite: 'strict' }
  }
});

export type Auth = typeof auth;

/**
 * Forward Set-Cookie headers from a better-auth Response into SvelteKit's
 * `event.cookies`. Used by /login, /logout, /account form actions that
 * call `auth.api.*({ asResponse: true })` directly. Replaces what the
 * `sveltekitCookies` plugin would do; see comment at top of this file.
 */
export function forwardCookiesFromResponse(response: Response, cookies: Cookies): void {
  const setCookies = response.headers.getSetCookie();
  for (const header of setCookies) {
    const parsed = parseSetCookieHeader(header);
    for (const [name, attrs] of parsed) {
      const opts = toCookieOptions(attrs);
      cookies.set(name, attrs.value, {
        ...opts,
        path: opts.path ?? '/'
      } as Parameters<Cookies['set']>[2]);
    }
  }
}
