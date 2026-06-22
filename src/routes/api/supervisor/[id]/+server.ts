import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { t } from '$lib/i18n';
import {
  getLlmOversightVerdict,
  getSupervisorRunForUser,
  listSupervisorRunEvents,
  listSupervisorSteps
} from '$lib/server/db/queries';

/**
 * GET /api/supervisor/:id — run detail: the run, its steps (with the latest QC
 * verdict resolved), and the recent event timeline. The frontend polls this
 * for live status. 404 (not 403) for foreign runs so ids aren't leaked.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const run = getSupervisorRunForUser(params.id, locals.user.id);
  if (!run) return json({ error: 'not found' }, { status: 404 });

  const steps = listSupervisorSteps(run.id).map((step) => {
    let verdict: unknown = null;
    if (step.last_verdict_id) {
      const row = getLlmOversightVerdict(step.last_verdict_id);
      if (row) {
        try {
          verdict = { verdict: row.verdict, ...JSON.parse(row.rationale) };
        } catch {
          verdict = { verdict: row.verdict };
        }
      }
    }
    return { ...step, verdict };
  });

  return json({ run, steps, events: listSupervisorRunEvents(run.id) });
};
