import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import { getSupervisorRunForUser } from '$lib/server/db/queries';
import { getEngine } from '$lib/server/bootstrap';

/**
 * POST /api/supervisor/:id/stop — body { mode: 'normal' | 'emergency' }.
 *   normal:    stop enqueuing new steps; let the current step finish, then halt.
 *   emergency: cancel all of this run's queue entries (killing their agents)
 *              and abort immediately.
 */
export const POST: RequestHandler = async ({ locals, params, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const run = getSupervisorRunForUser(params.id, locals.user.id);
  if (!run) return json({ error: 'not found' }, { status: 404 });

  let mode: 'normal' | 'emergency' = 'normal';
  try {
    const body = (await request.json()) as { mode?: unknown };
    if (body.mode === 'emergency') mode = 'emergency';
  } catch {
    // default normal
  }

  await getEngine().requestStop(run.id, mode);
  return json({ ok: true });
};
