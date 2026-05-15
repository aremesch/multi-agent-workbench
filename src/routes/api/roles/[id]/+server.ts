import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import {
  countAgentsUsingRole,
  deleteRole,
  getRole,
  updateRole
} from '$lib/server/db/queries';
import { sanitizeCapabilityValue } from '$lib/server/agents/adapters/capabilityValidation';
import { t } from '$lib/i18n';

/**
 * GET /api/roles/:id — return a single role's full row for the role-edit
 * dialog. Owner-scoped; 404 (not 403) for foreign rows to avoid leaking
 * existence.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const row = getRole(params.id);
  if (!row || row.user_id !== locals.user.id) {
    return json({ error: t(locals.locale, 'roles.error.notFound') }, { status: 404 });
  }
  return json(row);
};

/**
 * PUT /api/roles/:id — edit name, system_prompt, cli_kind, defaults.
 *
 * cli_kind is editable on purpose: a user may misclassify a role at create
 * time and want to fix it. We re-validate `default_model` and
 * `default_permission_mode` against the NEW cli_kind, so changing kinds
 * automatically nulls any defaults that no longer apply.
 */
export const PUT: RequestHandler = async ({ locals, params, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }

  const existing = getRole(params.id);
  if (!existing || existing.user_id !== locals.user.id) {
    return json({ error: t(locals.locale, 'roles.error.notFound') }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const name = String(b.name ?? '').trim();
  if (!name) {
    return json({ error: t(locals.locale, 'common.error.nameRequired') }, { status: 400 });
  }

  const cli_kind = typeof b.cli_kind === 'string' ? b.cli_kind.trim() : existing.cli_kind;
  const adapters = locals.supervisor.registry.list();
  const adapter = adapters.find((k) => k.kind === cli_kind);
  if (!adapter) {
    return json({ error: t(locals.locale, 'spawn.error.unknownCliKind') }, { status: 400 });
  }

  const system_prompt =
    typeof b.system_prompt === 'string' ? b.system_prompt : existing.system_prompt;
  const default_args_json =
    typeof b.default_args_json === 'string' ? b.default_args_json : existing.default_args_json;
  const tool_config_json =
    typeof b.tool_config_json === 'string' ? b.tool_config_json : existing.tool_config_json;
  const repo_scope_json =
    typeof b.repo_scope_json === 'string' ? b.repo_scope_json : existing.repo_scope_json;

  const default_model = sanitizeCapabilityValue(adapter.capabilities.model, b.default_model);
  const default_permission_mode = sanitizeCapabilityValue(
    adapter.capabilities.permissionMode,
    b.default_permission_mode
  );

  const ok = updateRole({
    id: params.id,
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
  if (!ok) {
    return json({ error: t(locals.locale, 'roles.error.notFound') }, { status: 404 });
  }
  return json(getRole(params.id));
};

/**
 * DELETE /api/roles/:id — remove a role. 409 if any agent (live or archived)
 * still references it; the archive view joins on `agents.role_id` for the
 * role-name caption, so we refuse to dangle that join.
 */
export const DELETE: RequestHandler = async ({ locals, params, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const row = getRole(params.id);
  if (!row || row.user_id !== locals.user.id) {
    return json({ error: t(locals.locale, 'roles.error.notFound') }, { status: 404 });
  }
  const inUse = countAgentsUsingRole(params.id);
  if (inUse > 0) {
    return json(
      { error: t(locals.locale, 'roles.error.inUse', { count: String(inUse) }), count: inUse },
      { status: 409 }
    );
  }
  const ok = deleteRole(params.id, locals.user.id);
  if (!ok) {
    return json({ error: t(locals.locale, 'roles.error.notFound') }, { status: 404 });
  }
  return json({ ok: true });
};
