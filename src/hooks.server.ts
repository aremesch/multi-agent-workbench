/**
 * SvelteKit server hook.
 *
 * Responsibilities:
 *   1. Await bootstrap() — idempotent, safe to call per-request; the guard
 *      inside bootstrap.ts makes the second call a no-op.
 *   2. Populate event.locals with the resolved user/session + supervisor.
 *   3. Issue a CSRF token cookie the first time a visitor shows up.
 */

import type { Handle } from '@sveltejs/kit';
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

  // Inject the user's active theme into <html data-theme="..."> so the
  // first paint already uses the right token set (no FOUC).
  const theme = user ? parseTheme(getUserSetting(user.id, THEME_SETTING_KEY)) : DEFAULT_THEME;

  // Resolve locale: saved preference for authenticated users, Accept-Language for guests.
  const locale = user
    ? parseLocale(getUserSetting(user.id, LOCALE_SETTING_KEY))
    : detectLocale(event.request.headers.get('accept-language'));
  event.locals.locale = locale;

  return resolve(event, {
    transformPageChunk: ({ html }) =>
      html.replace('%maw.theme%', theme).replace('%maw.locale%', locale)
  });
};
