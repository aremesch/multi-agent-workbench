import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import {
  getSupervisorRunForUser,
  listSupervisorSteps,
  updateSupervisorStep
} from '$lib/server/db/queries';
import { getEngine } from '$lib/server/bootstrap';

/**
 * POST /api/supervisor/:id/approve — approve steps and start execution.
 *
 * Body: { stepIds?: string[] }. When omitted, every still-pending step is
 * approved ("approve all & run"). Then the run transitions to executing.
 */
export const POST: RequestHandler = async ({ locals, params, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const run = getSupervisorRunForUser(params.id, locals.user.id);
  if (!run) return json({ error: 'not found' }, { status: 404 });
  if (run.phase !== 'awaiting_approval') {
    return json({ error: 'run is not awaiting approval' }, { status: 409 });
  }

  let stepIds: string[] | null = null;
  try {
    const body = (await request.json()) as { stepIds?: unknown };
    if (Array.isArray(body.stepIds)) {
      stepIds = body.stepIds.filter((s): s is string => typeof s === 'string');
    }
  } catch {
    // empty body → approve all
  }

  const steps = listSupervisorSteps(run.id);
  const target = stepIds ? steps.filter((s) => stepIds!.includes(s.id)) : steps;
  for (const s of target) {
    if (s.approval_state !== 'approved') updateSupervisorStep(s.id, { approval_state: 'approved' });
  }

  getEngine().approveRun(run.id);
  return json({ ok: true });
};
