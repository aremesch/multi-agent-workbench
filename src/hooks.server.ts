/**
 * SvelteKit server hook.
 *
 * Responsibilities:
 *   1. Await bootstrap() — idempotent, safe to call per-request; the guard
 *      inside bootstrap.ts makes the second call a no-op.
 *   2. Populate event.locals with the resolved user/session + supervisor.
 *   3. Issue a CSRF token cookie the first time a visitor shows up.
 */

import { redirect, type Handle } from '@sveltejs/kit';
import { bootstrap, getSupervisor } from '$lib/server/bootstrap';
import { resolveSession } from '$lib/server/auth/session';
import { ensureCsrfCookie } from '$lib/server/auth/csrf';
import { getUserSetting } from '$lib/server/db/queries';
import { DEFAULT_THEME, THEME_SETTING_KEY, parseTheme } from '$lib/shared/dashboard';
import { DEFAULT_LOCALE, LOCALE_SETTING_KEY, detectLocale, parseLocale } from '$lib/i18n';

await bootstrap();

export const handle: Handle = async ({ event, resolve }) => {
  const { user, session } = resolveSession(event.cookies);
  event.locals.user = user;
  event.locals.session = session;
  event.locals.supervisor = getSupervisor();

  ensureCsrfCookie(event.cookies);

  // Force a seeded-password user through /account before they can touch
  // anything else. Allowlist the change-password page itself, the login +
  // logout flow, and the service-worker / static assets.
  if (user?.must_change_password) {
    const p = event.url.pathname;
    const allow =
      p === '/account' ||
      p === '/login' ||
      p === '/logout' ||
      p.startsWith('/_app/') ||
      p.startsWith('/static/') ||
      p === '/service-worker.js' ||
      p === '/favicon.ico' ||
      p === '/manifest.webmanifest';
    if (!allow) throw redirect(303, '/account');
  }

  // Inject the user's active theme into <html data-theme="..."> so the
  // first paint already uses the right token set (no FOUC).
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
  // CSP notes: SvelteKit style hydration needs 'unsafe-inline' for styles;
  // we deliberately do NOT allow it for scripts. Revisit once we wire up
  // CSP nonces via SvelteKit's csp config.
  const h = response.headers;
  if (!h.has('Content-Security-Policy')) {
    h.set(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
  }
  if (!h.has('Strict-Transport-Security')) {
    h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  return response;
};
