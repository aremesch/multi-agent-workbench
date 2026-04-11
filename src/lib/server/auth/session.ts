/**
 * Session cookie + validation.
 *
 * The cookie stores an opaque session id (ulid). Session rows live in SQLite
 * with an expires_at. On every request, hooks.server.ts resolves the cookie
 * to a user or clears it.
 *
 * Cookie is httpOnly + SameSite=Lax + Secure in production. CSRF is handled
 * separately by csrf.ts using a double-submit token.
 */

import { ulid } from 'ulid';
import type { Cookies } from '@sveltejs/kit';
import {
  deleteSession,
  getSessionById,
  getUserById,
  insertSession
} from '../db/queries.js';
import type { SessionRow, UserRow } from '../db/types.js';
import { getConfig } from '../config.js';

export const SESSION_COOKIE = 'maw_session';

export function createSession(userId: string, userAgent: string | null): SessionRow {
  const id = ulid();
  const cfg = getConfig();
  const expires_at = Math.floor(Date.now() / 1000) + cfg.sessionTtlSeconds;
  insertSession({ id, user_id: userId, expires_at, user_agent: userAgent });
  // Re-read to return the full row (cheap: same prepared statement path).
  return { id, user_id: userId, expires_at, user_agent: userAgent, created_at: 0, updated_at: 0 };
}

export function resolveSession(cookies: Cookies): { user: UserRow | null; session: SessionRow | null } {
  const sid = cookies.get(SESSION_COOKIE);
  if (!sid) return { user: null, session: null };
  const session = getSessionById(sid);
  if (!session) return { user: null, session: null };
  if (session.expires_at < Math.floor(Date.now() / 1000)) {
    deleteSession(sid);
    return { user: null, session: null };
  }
  const user = getUserById(session.user_id);
  if (!user) return { user: null, session: null };
  return { user, session };
}

export function setSessionCookie(cookies: Cookies, sessionId: string): void {
  const cfg = getConfig();
  cookies.set(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !cfg.isDev,
    maxAge: cfg.sessionTtlSeconds
  });
}

export function clearSessionCookie(cookies: Cookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
}
