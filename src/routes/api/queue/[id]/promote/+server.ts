import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import { getScheduler } from '$lib/server/bootstrap';

/**
 * POST /api/queue/:id/promote — promote the entry NOW, bypassing slot caps.
 *
 * Still respects validation (role/repo must exist, branch must be present)
 * and exclusive locking (refuses to stomp on a currently exclusive agent on
 * the same repo). Used by the queue UI's "Run now" action when the user
 * wants to override the scheduled order.
 */
export const POST: RequestHandler = async ({ locals, params, cookies, request }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const result = await getScheduler().promoteEntry(params.id, locals.user.id);
  if (!result.ok) {
    return json({ error: result.error }, { status: 409 });
  }
  return json({ ok: true });
};
