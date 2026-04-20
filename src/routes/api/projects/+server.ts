import { json } from '@sveltejs/kit';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { insertProject } from '$lib/server/db/queries';
import { t } from '$lib/i18n';

const BRANCH_RE = /^[\w./-]+$/;

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const name = String(b.name ?? '').trim();
  const default_branch = String(b.default_branch ?? '').trim() || 'main';

  if (!name) return json({ error: t(locals.locale, 'common.error.nameRequired') }, { status: 400 });
  if (!BRANCH_RE.test(default_branch))
    return json({ error: t(locals.locale, 'common.error.invalidBranch') }, { status: 400 });

  const id = ulid();
  insertProject({ id, user_id: locals.user.id, name, default_branch });
  return json({ id, name, default_branch });
};
