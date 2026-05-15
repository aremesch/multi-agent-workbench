import { json } from '@sveltejs/kit';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { insertRole, listRoles } from '$lib/server/db/queries';
import { t } from '$lib/i18n';
import { sanitizeCapabilityValue } from '$lib/server/agents/adapters/capabilityValidation';

/**
 * GET /api/roles — list every role belonging to the current user. Used by
 * the /roles page table view; the spawn dialog has its own loader.
 */
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user)
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  const rows = listRoles(locals.user.id);
  return json({ roles: rows });
};

/**
 * POST /api/roles — create a new role. Accepts the full role shape including
 * adapter-specific defaults (`default_model`, `default_permission_mode`).
 * Both are validated against the adapter's `capabilities.*.values` list, so
 * the dialog can't smuggle in a model name the registry doesn't recognise.
 */
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
  const default_args_json = typeof b.default_args_json === 'string' ? b.default_args_json : '{}';
  const tool_config_json = typeof b.tool_config_json === 'string' ? b.tool_config_json : '{}';
  const repo_scope_json = typeof b.repo_scope_json === 'string' ? b.repo_scope_json : '{}';

  if (!name) return json({ error: t(locals.locale, 'common.error.nameRequired') }, { status: 400 });

  const adapters = locals.supervisor.registry.list();
  const adapter = adapters.find((k) => k.kind === cli_kind);
  if (!adapter) {
    return json({ error: t(locals.locale, 'spawn.error.unknownCliKind') }, { status: 400 });
  }

  const default_model = sanitizeCapabilityValue(adapter.capabilities.model, b.default_model);
  const default_permission_mode = sanitizeCapabilityValue(
    adapter.capabilities.permissionMode,
    b.default_permission_mode
  );

  const id = ulid();
  insertRole({
    id,
    user_id: locals.user.id,
    name,
    system_prompt,
    cli_kind,
    default_args_json,
    tool_config_json,
    repo_scope_json,
    default_model,
    default_permission_mode
  });
  return json({
    id,
    name,
    cli_kind,
    system_prompt,
    default_args_json,
    tool_config_json,
    repo_scope_json,
    default_model,
    default_permission_mode
  });
};
