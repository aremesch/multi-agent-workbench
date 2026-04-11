import { json } from '@sveltejs/kit';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { insertRole } from '$lib/server/db/queries';

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
  const cli_kind = String(b.cli_kind ?? '').trim();
  const system_prompt = String(b.system_prompt ?? '');

  if (!name) return json({ error: 'Name is required' }, { status: 400 });

  const validKinds = new Set(locals.supervisor.registry.list().map((k) => k.kind));
  if (!validKinds.has(cli_kind)) return json({ error: 'Unknown CLI kind' }, { status: 400 });

  const id = ulid();
  insertRole({
    id,
    user_id: locals.user.id,
    name,
    system_prompt,
    cli_kind,
    default_args_json: '{}',
    tool_config_json: '{}',
    repo_scope_json: '{}'
  });
  return json({ id, name, cli_kind });
};
