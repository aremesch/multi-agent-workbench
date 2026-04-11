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

await bootstrap();

export const handle: Handle = async ({ event, resolve }) => {
  const { user, session } = resolveSession(event.cookies);
  event.locals.user = user;
  event.locals.session = session;
  event.locals.supervisor = getSupervisor();

  ensureCsrfCookie(event.cookies);

  return resolve(event);
};
