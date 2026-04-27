/**
 * SvelteKit server hook.
 *
 * Responsibilities:
 *   1. Await bootstrap() — idempotent, safe to call per-request; the guard
 *      inside bootstrap.ts makes the second call a no-op.
 *   2. Ask better-auth for the session and adapt it to event.locals.user /
 *      event.locals.session shapes the rest of the app expects.
 *   3. Issue a CSRF token cookie the first time a visitor shows up.
 *   4. Enforce the must_change_password redirect on bootstrap users.
 *   5. Apply security response headers.
 *
 * The /api/auth/* routes are handled by src/routes/api/auth/[...all]/+server.ts
 * which calls auth.handler() directly — this hook just runs around them.
 */

import { redirect, type Handle } from '@sveltejs/kit';
import { bootstrap, getSupervisor } from '$lib/server/bootstrap';
import { auth } from '$lib/server/auth/betterAuth';
import { ensureCsrfCookie } from '$lib/server/auth/csrf';
import { getMustChangePasswordById, getUserSetting } from '$lib/server/db/queries';
import { DEFAULT_THEME, THEME_SETTING_KEY, parseTheme } from '$lib/shared/dashboard';
import { LOCALE_SETTING_KEY, detectLocale, parseLocale } from '$lib/i18n';

await bootstrap();

export const handle: Handle = async ({ event, resolve }) => {
  const sess = await auth.api.getSession({ headers: event.request.headers });

  event.locals.user = sess
    ? {
        id: sess.user.id,
        // Display name = email's local-part. For the migrated bootstrap user
        // (admin@maw.local) this matches the historic users.username value.
        username: sess.user.email.split('@')[0] ?? sess.user.email,
        must_change_password: getMustChangePasswordById(sess.user.id) ? 1 : 0
      }
    : null;
  event.locals.session = sess ? { id: sess.session.id, userId: sess.session.userId } : null;
  event.locals.supervisor = getSupervisor();

  ensureCsrfCookie(event.cookies);

  // Force a seeded-password user through /account before they can touch
  // anything else. Allowlist /account itself, the login/logout flow, the
  // /api/auth/* endpoints, and the service-worker / static assets.
  if (event.locals.user?.must_change_password) {
    const p = event.url.pathname;
    const allow =
      p === '/account' ||
      p === '/login' ||
      p === '/logout' ||
      p.startsWith('/api/auth/') ||
      p.startsWith('/_app/') ||
      p.startsWith('/static/') ||
      p === '/service-worker.js' ||
      p === '/favicon.ico' ||
      p === '/manifest.webmanifest';
    if (!allow) throw redirect(303, '/account');
  }

  // Inject the user's active theme into <html data-theme="..."> so the
  // first paint already uses the right token set (no FOUC).
  const user = event.locals.user;
  const theme = user ? parseTheme(getUserSetting(user.id, THEME_SETTING_KEY)) : DEFAULT_THEME;

  // Resolve locale: saved preference for authenticated users, Accept-Language for guests.
  const locale = user
    ? parseLocale(getUserSetting(user.id, LOCALE_SETTING_KEY))
    : detectLocale(event.request.headers.get('accept-language'));
  event.locals.locale = locale;

  const response = await resolve(event, {
    transformPageChunk: ({ html }) =>
      html.replace('%maw.theme%', theme).replace('%maw.locale%', locale)
  });

  // Security response headers. Applied to every response, including API
  // and WS-adjacent ones — they're cheap and some (X-Content-Type-Options,
  // Referrer-Policy) matter on non-HTML responses too.
  //
  // CSP is emitted by SvelteKit itself (see `kit.csp` in svelte.config.js)
  // so its inline hydration script gets a matching SHA-256 hash. Setting
  // a second, flat CSP here would be intersected by the browser and would
  // silently block that inline script — killing every onclick in the app.
  const h = response.headers;
  if (!h.has('Strict-Transport-Security')) {
    h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  return response;
};
