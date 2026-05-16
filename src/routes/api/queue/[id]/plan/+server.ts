/**
 * GET /api/queue/:id/plan — return the rendered markdown plan stored on a
 * queue entry, alongside the raw markdown for clipboard copy.
 *
 * 404 when the entry doesn't exist, isn't owned by the caller, or has no
 * `plan_md` set. The HTML is sanitized through the same pipeline as the
 * agent-window plan viewer (`renderPlanMarkdownToHtml`) so the client can
 * render it via `{@html}` without further work.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { t } from '$lib/i18n';
import { getQueueEntryForUser } from '$lib/server/db/queries';
import { renderPlanMarkdownToHtml } from '$lib/server/plans/agentPlans';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const entry = getQueueEntryForUser(params.id, locals.user.id);
  if (!entry) {
    return json({ error: t(locals.locale, 'queue.error.notFound') }, { status: 404 });
  }
  if (!entry.plan_md) {
    return json({ error: t(locals.locale, 'queue.error.noPlan') }, { status: 404 });
  }
  const html = renderPlanMarkdownToHtml(entry.plan_md);
  return json({
    markdown: entry.plan_md,
    html,
    source_path: entry.plan_source_path
  });
};
