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
import { sequence } from '@sveltejs/kit/hooks';
import { bootstrap, getSupervisor } from '$lib/server/bootstrap';
import { resolveSession } from '$lib/server/auth/session';
import { ensureCsrfCookie } from '$lib/server/auth/csrf';
import { getUserSetting } from '$lib/server/db/queries';
import { DEFAULT_THEME, THEME_SETTING_KEY, parseTheme } from '$lib/shared/dashboard';
import { DEFAULT_LOCALE, LOCALE_SETTING_KEY, detectLocale, parseLocale } from '$lib/i18n';

await bootstrap();

const baseHandle: Handle = async ({ event, resolve }) => {
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

// SvelteKit form actions pin the wire status at 200 when the client takes
// the JSON-action path (Accept negotiates application/json — true for the
// default `Accept: */*` of curl / fetch / bots, since the kit lists JSON
// first in its priority array). The fail() status only survives in the
// response body. Browsers prioritise text/html and already get the right
// wire status. This hook re-emits body.status onto the wire so non-browser
// clients see real 4xx codes — important for HTTP-status-based monitoring
// and WAF rules. fail2ban is unaffected (it parses MAW's own auth.log).
const honestActionStatus: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  if (
    event.request.method !== 'POST' ||
    response.status !== 200 ||
    !response.headers.get('content-type')?.startsWith('application/json')
  ) {
    return response;
  }

  const text = await response.clone().text();
  let parsed: { type?: string; status?: number } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return response;
  }

  if (
    parsed?.type === 'failure' &&
    typeof parsed.status === 'number' &&
    parsed.status >= 400 &&
    parsed.status < 600
  ) {
    return new Response(text, {
      status: parsed.status,
      headers: response.headers
    });
  }

  return response;
};

export const handle = sequence(baseHandle, honestActionStatus);
