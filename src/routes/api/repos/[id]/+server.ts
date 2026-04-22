import { json } from '@sveltejs/kit';
import { basename } from 'node:path';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { getProject, getRepo, updateRepo } from '$lib/server/db/queries';
import { t } from '$lib/i18n';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  const repo = getRepo(params.id);
  if (!repo || repo.user_id !== locals.user.id) {
    return json({ error: t(locals.locale, 'common.error.repoNotFound') }, { status: 404 });
  }
  const projectName = repo.project_id ? (getProject(repo.project_id)?.name ?? null) : null;
  return json({
    id: repo.id,
    path: repo.path,
    origin_url: repo.origin_url,
    default_branch: repo.default_branch,
    projectName: projectName ?? basename(repo.path)
  });
};

export const PUT: RequestHandler = async ({ locals, params, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const origin_raw = b.origin_url;
  const origin_url =
    origin_raw === null || origin_raw === undefined
      ? null
      : String(origin_raw).trim() || null;

  const ok = updateRepo({ id: params.id, user_id: locals.user.id, origin_url });
  if (!ok) return json({ error: t(locals.locale, 'common.error.repoNotFound') }, { status: 404 });
  return json({ ok: true, id: params.id, origin_url });
};
