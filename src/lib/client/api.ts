/**
 * Client-side fetch wrapper that attaches the CSRF header to non-GET
 * requests. The `maw_csrf` cookie is set by `ensureCsrfCookie()` in
 * `hooks.server.ts` on every request; we double-submit it in
 * `x-csrf-token` so the server (`verifyCsrf`) can reject cross-origin
 * requests that managed to replay the session cookie.
 *
 * All callers targeting `/api/*` (or any MAW JSON endpoint) should use
 * this helper instead of raw `fetch` — it's one line at the callsite
 * and keeps the cookie-reading logic out of individual components.
 */

const CSRF_COOKIE = 'maw_csrf';
const CSRF_HEADER = 'x-csrf-token';

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === CSRF_COOKIE && v) return decodeURIComponent(v);
  }
  return null;
}

export async function apiFetch(
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return fetch(input, init);
  }
  const token = readCsrfToken();
  const headers = new Headers(init.headers);
  if (token && !headers.has(CSRF_HEADER)) headers.set(CSRF_HEADER, token);
  return fetch(input, { ...init, headers });
}
