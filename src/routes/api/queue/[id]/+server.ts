import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import {
  getQueueEntryForUser,
  listQueueEntriesByIds,
  updateQueueEntryFields
} from '$lib/server/db/queries';
import { getScheduler } from '$lib/server/bootstrap';
import { coerceQueueInput, validateQueueInput } from '../_payload';

/**
 * GET /api/queue/:id — fetch one entry. 404 (not 403) for foreign rows so
 * the existence of someone else's entry id isn't leaked.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const row = getQueueEntryForUser(params.id, locals.user.id);
  if (!row) {
    return json({ error: t(locals.locale, 'queue.error.notFound') }, { status: 404 });
  }
  return json(row);
};

/**
 * PUT /api/queue/:id — edit a queue entry.
 *
 * Refuses to edit entries that are already `running`, `done`, `failed`, or
 * `cancelled`. To "edit" a finished entry, the user should clone it.
 *
 * Re-runs the spawn validator so adapter / role / repo changes are caught
 * immediately rather than deferred to promote time.
 */
export const PUT: RequestHandler = async ({ locals, params, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const existing = getQueueEntryForUser(params.id, locals.user.id);
  if (!existing) {
    return json({ error: t(locals.locale, 'queue.error.notFound') }, { status: 404 });
  }
  if (existing.status === 'running' || existing.status === 'done' || existing.status === 'failed' || existing.status === 'cancelled') {
    return json({ error: t(locals.locale, 'queue.error.notEditable') }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }
  const coerce = coerceQueueInput(body);
  if (!coerce.ok) {
    return json({ error: t(locals.locale, coerce.errorKey) }, { status: 400 });
  }
  // Self-dependency check (cycle prevention degenerate case).
  if (coerce.value.dependsOn.includes(params.id)) {
    return json({ error: t(locals.locale, 'queue.error.dependsOnSelf') }, { status: 400 });
  }
  // All deps must belong to this user; we don't search foreign queues.
  if (coerce.value.dependsOn.length > 0) {
    const deps = listQueueEntriesByIds(coerce.value.dependsOn, locals.user.id);
    if (deps.length !== new Set(coerce.value.dependsOn).size) {
      return json({ error: t(locals.locale, 'queue.error.unknownDependency') }, { status: 400 });
    }
  }

  const validation = await validateQueueInput(coerce.value, locals.user.id, locals.supervisor.registry);
  if (!validation.ok) {
    return json({ error: t(locals.locale, validation.errorKey) }, { status: 400 });
  }
  const v = validation.value;

  // Re-evaluation: status flips back to 'pending' so the scheduler can
  // re-classify deps / scheduled_for next tick. last_error cleared because
  // the saved values are now valid as far as we can tell.
  updateQueueEntryFields(params.id, {
    role_id: v.role.id,
    title: v.title,
    body: v.adapter.initialInputDelivery === 'cli-arg' ? coerce.value.taskBody : null,
    target_url: v.browser ? v.browser.target_url : null,
    model: v.model,
    permission_mode: v.permissionMode,
    source_branch: v.adapterSupportsWorktree ? v.branchStartPoint : null,
    with_worktree: v.shouldCreateWorktree,
    optional_args_json: JSON.stringify(coerce.value.optionalArgs ?? {}),
    priority: coerce.value.priority,
    depends_on_json: JSON.stringify(coerce.value.dependsOn),
    scheduled_for: coerce.value.scheduledFor,
    exclusive: coerce.value.exclusive
  });

  getScheduler().scheduleTick();
  return json({ ok: true });
};

/**
 * DELETE /api/queue/:id — cancel the entry. Soft-delete: the row stays so
 * audit history and dependency graphs remain consistent. If the entry is
 * `running`, the linked agent is killed.
 */
export const DELETE: RequestHandler = async ({ locals, params, cookies, request }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const ok = await getScheduler().cancelEntry(params.id, locals.user.id);
  if (!ok) {
    return json({ error: t(locals.locale, 'queue.error.notFound') }, { status: 404 });
  }
  return json({ ok: true });
};
