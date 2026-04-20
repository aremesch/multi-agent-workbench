/**
 * Double-submit CSRF for JSON endpoints.
 *
 * SvelteKit's built-in form-action CSRF covers HTML form posts. For fetch()
 * calls to +server.ts routes with JSON bodies, we require a matching token
 * in `x-csrf-token` header + `maw_csrf` cookie.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { error, type Cookies, type RequestEvent } from '@sveltejs/kit';

export const CSRF_COOKIE = 'maw_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function ensureCsrfCookie(cookies: Cookies): string {
  const existing = cookies.get(CSRF_COOKIE);
  if (existing) return existing;
  const token = randomBytes(24).toString('base64url');
  cookies.set(CSRF_COOKIE, token, {
    path: '/',
    httpOnly: false, // readable by client JS so it can echo back in the header
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365
  });
  return token;
}

/**
 * Verify the double-submit CSRF token. Throws a SvelteKit 403 on mismatch,
 * which lets callers write `verifyCsrf(event)` at the top of a handler
 * without further branching.
 */
export function verifyCsrf(event: Pick<RequestEvent, 'cookies' | 'request'>): void {
  const cookie = event.cookies.get(CSRF_COOKIE);
  const header = event.request.headers.get(CSRF_HEADER);
  if (!cookie || !header) throw error(403, 'csrf');
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw error(403, 'csrf');
}
