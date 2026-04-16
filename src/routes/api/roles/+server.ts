import { json } from '@sveltejs/kit';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { insertRole } from '$lib/server/db/queries';
import { t } from '$lib/i18n';

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
  const cli_kind = String(b.cli_kind ?? '').trim();
  const system_prompt = String(b.system_prompt ?? '');

  if (!name) return json({ error: t(locals.locale, 'common.error.nameRequired') }, { status: 400 });

  const validKinds = new Set(locals.supervisor.registry.list().map((k) => k.kind));
  if (!validKinds.has(cli_kind)) return json({ error: t(locals.locale, 'spawn.error.unknownCliKind') }, { status: 400 });

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
