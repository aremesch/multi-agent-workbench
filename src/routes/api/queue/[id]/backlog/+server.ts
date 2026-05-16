import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import { getScheduler } from '$lib/server/bootstrap';

/**
 * POST /api/queue/:id/backlog — send a queued entry back to the backlog.
 *
 * Flips `queued = 0`. Valid only on pending/blocked/ready rows; 409 when the
 * entry is running (kill it via DELETE instead) or already terminal.
 */
export const POST: RequestHandler = async ({ locals, params, cookies, request }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const ok = getScheduler().backlogEntry(params.id, locals.user.id);
  if (!ok) {
    return json({ error: t(locals.locale, 'queue.error.notBacklogable') }, { status: 409 });
  }
  return json({ ok: true });
};
