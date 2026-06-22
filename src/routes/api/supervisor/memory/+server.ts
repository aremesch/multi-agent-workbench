import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import { getRepo, listProjectMemory, setProjectMemoryActive } from '$lib/server/db/queries';

/**
 * GET /api/supervisor/memory?repo_id=… — the repo's project-memory lessons
 * (recurring issue classes the supervisor has accumulated).
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const repoId = url.searchParams.get('repo_id') ?? '';
  const repo = getRepo(repoId);
  if (!repo || repo.user_id !== locals.user.id) return json({ error: 'unknown repo' }, { status: 400 });
  return json({ lessons: listProjectMemory(repoId, false) });
};

/**
 * POST /api/supervisor/memory — retire (or reactivate) a lesson.
 * Body: { id, active }.
 */
export const POST: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  let body: { id?: unknown; active?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }
  if (typeof body.id !== 'string') return json({ error: 'id required' }, { status: 400 });
  const ok = setProjectMemoryActive(body.id, locals.user.id, body.active !== false);
  if (!ok) return json({ error: 'not found' }, { status: 404 });
  return json({ ok: true });
};
