import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import {
  getSupervisorRunForUser,
  getSupervisorStep,
  updateSupervisorStep
} from '$lib/server/db/queries';
import { getEngine } from '$lib/server/bootstrap';

/**
 * POST /api/supervisor/:id/step/:stepId — act on one step.
 *
 * Body: { action: 'edit' | 'send_back' | 'resolve', ... }
 *   edit:      { title?, body?, seq?, dependsOn? } — only while awaiting_approval.
 *   send_back: { notes } — mark for refinement + re-run the planner on it.
 *   resolve:   { resolution: 'resume' | 'skip' } — clear a blocked_on_human step.
 */
export const POST: RequestHandler = async ({ locals, params, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const run = getSupervisorRunForUser(params.id, locals.user.id);
  if (!run) return json({ error: 'not found' }, { status: 404 });
  const step = getSupervisorStep(params.stepId);
  if (!step || step.run_id !== run.id) return json({ error: 'not found' }, { status: 404 });

  let body: { action?: unknown; [k: string]: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }

  switch (body.action) {
    case 'edit': {
      if (run.phase !== 'awaiting_approval') {
        return json({ error: 'can only edit before approval' }, { status: 409 });
      }
      const patch: Parameters<typeof updateSupervisorStep>[1] = {};
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.body === 'string') patch.body = body.body;
      if (typeof body.seq === 'number') patch.seq = Math.floor(body.seq);
      if (Array.isArray(body.dependsOn)) {
        patch.depends_on_json = JSON.stringify(body.dependsOn.filter((x): x is string => typeof x === 'string'));
      }
      updateSupervisorStep(step.id, patch);
      return json({ ok: true });
    }
    case 'send_back': {
      if (run.phase !== 'awaiting_approval') {
        return json({ error: 'can only refine before approval' }, { status: 409 });
      }
      const notes = typeof body.notes === 'string' ? body.notes : '';
      updateSupervisorStep(step.id, { approval_state: 'sent_back', refinement_notes: notes });
      void getEngine().refineStep(step.id);
      return json({ ok: true });
    }
    case 'resolve': {
      const resolution = body.resolution === 'skip' ? 'skip' : 'resume';
      await getEngine().resolveBlock(step.id, resolution);
      return json({ ok: true });
    }
    default:
      return json({ error: 'unknown action' }, { status: 400 });
  }
};
