import { json } from '@sveltejs/kit';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { insertProject } from '$lib/server/db/queries';

const BRANCH_RE = /^[\w./-]+$/;

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const name = String(b.name ?? '').trim();
  const default_branch = String(b.default_branch ?? '').trim() || 'main';

  if (!name) return json({ error: 'Name is required' }, { status: 400 });
  if (!BRANCH_RE.test(default_branch))
    return json({ error: 'Default branch contains invalid characters' }, { status: 400 });

  const id = ulid();
  insertProject({ id, user_id: locals.user.id, name, default_branch });
  return json({ id, name, default_branch });
};
