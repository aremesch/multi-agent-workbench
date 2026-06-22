import { json } from '@sveltejs/kit';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import {
  getRepo,
  getRole,
  getSupervisorSettings,
  insertSupervisorRun,
  listSupervisorRunsForUser
} from '$lib/server/db/queries';
import { getEngine } from '$lib/server/bootstrap';

/** GET /api/supervisor — list the caller's runs. */
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  return json({ runs: listSupervisorRunsForUser(locals.user.id) });
};

/**
 * POST /api/supervisor — create a run from a product plan and kick off
 * planning. Body: { title, planMd, repoId, roleId, qcRoleId }.
 *
 * The current supervisor settings are frozen into the run's config_json so a
 * later settings edit can't change a running run's semantics.
 */
export const POST: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  let body: {
    title?: unknown;
    planMd?: unknown;
    repoId?: unknown;
    roleId?: unknown;
    qcRoleId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const planMd = typeof body.planMd === 'string' ? body.planMd.trim() : '';
  const repoId = typeof body.repoId === 'string' ? body.repoId : '';
  const roleId = typeof body.roleId === 'string' ? body.roleId : '';
  const qcRoleId = typeof body.qcRoleId === 'string' ? body.qcRoleId : '';

  if (!title || !planMd) return json({ error: 'title and planMd are required' }, { status: 400 });

  const repo = getRepo(repoId);
  if (!repo || repo.user_id !== locals.user.id) return json({ error: 'unknown repo' }, { status: 400 });
  const role = getRole(roleId);
  if (!role || role.user_id !== locals.user.id) return json({ error: 'unknown coding role' }, { status: 400 });
  const qcRole = getRole(qcRoleId);
  if (!qcRole || qcRole.user_id !== locals.user.id) return json({ error: 'unknown QC role' }, { status: 400 });

  const id = ulid();
  insertSupervisorRun({
    id,
    user_id: locals.user.id,
    repo_id: repoId,
    role_id: roleId,
    qc_role_id: qcRoleId,
    title,
    plan_md: planMd,
    phase: 'planning',
    config_json: JSON.stringify(getSupervisorSettings(locals.user.id))
  });

  // Fire-and-forget planning; the UI polls for the awaiting_approval phase.
  void getEngine().startPlanning(id);
  return json({ id }, { status: 201 });
};
