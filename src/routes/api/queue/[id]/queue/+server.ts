import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import { getScheduler } from '$lib/server/bootstrap';

/**
 * POST /api/queue/:id/queue — admit a backlog entry into the queue.
 *
 * Flips `queued = 1`. Valid only on pending/blocked/ready rows; 404/409 when
 * the entry doesn't exist or is already running/terminal. The scheduler is
 * kicked so the entry can be classified and promoted as soon as capacity
 * permits.
 */
export const POST: RequestHandler = async ({ locals, params, cookies, request }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const ok = getScheduler().queueEntry(params.id, locals.user.id);
  if (!ok) {
    return json({ error: t(locals.locale, 'queue.error.notQueueable') }, { status: 409 });
  }
  return json({ ok: true });
};
