import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import { setQueueEntriesPriorities } from '$lib/server/db/queries';
import { getScheduler } from '$lib/server/bootstrap';

/**
 * POST /api/queue/reorder — bulk priority rewrite from drag-reorder.
 *
 * Body: `{ updates: [{ id, priority }, ...] }`. Each row is owner-scoped
 * inside the SQL UPDATE; foreign rows silently no-op (the row count of the
 * response tells the client how many actually changed).
 *
 * Runs in one transaction so the relative order is consistent for any tick
 * that lands mid-write.
 */
export const POST: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.updates)) {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }
  const updates: Array<{ id: string; priority: number }> = [];
  for (const u of b.updates) {
    if (
      u &&
      typeof u === 'object' &&
      typeof (u as Record<string, unknown>).id === 'string' &&
      typeof (u as Record<string, unknown>).priority === 'number' &&
      Number.isFinite((u as Record<string, unknown>).priority as number)
    ) {
      updates.push({
        id: (u as Record<string, unknown>).id as string,
        priority: Math.floor((u as Record<string, unknown>).priority as number)
      });
    }
  }
  const changed = setQueueEntriesPriorities(locals.user.id, updates);
  getScheduler().scheduleTick();
  return json({ changed });
};
