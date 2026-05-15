import { json } from '@sveltejs/kit';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import {
  insertQueueEntry,
  listQueueEntriesForUser,
  type ListQueueEntriesFilter,
  type QueueConcurrencySettings,
  getQueueConcurrency
} from '$lib/server/db/queries';
import type { QueueEntryStatus } from '$lib/server/db/types';
import { getScheduler } from '$lib/server/bootstrap';
import { coerceQueueInput, validateQueueInput } from './_payload';

const ALLOWED_STATUS = new Set<QueueEntryStatus>([
  'pending',
  'blocked',
  'ready',
  'running',
  'done',
  'failed',
  'cancelled'
]);

/**
 * GET /api/queue — list entries belonging to the caller.
 *
 * Query params:
 *   - status: comma-separated subset of QueueEntryStatus (default: all)
 *   - repo_id: filter to one repo
 *
 * Returns: { entries: QueueEntryRow[], concurrency: QueueConcurrencySettings }
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const filter: ListQueueEntriesFilter = {};
  const statusParam = url.searchParams.get('status');
  if (statusParam) {
    const parsed = statusParam
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is QueueEntryStatus => ALLOWED_STATUS.has(s as QueueEntryStatus));
    if (parsed.length > 0) filter.status = parsed;
  }
  const repoIdParam = url.searchParams.get('repo_id');
  if (repoIdParam) filter.repoId = repoIdParam;

  const entries = listQueueEntriesForUser(locals.user.id, filter);
  const concurrency: QueueConcurrencySettings = getQueueConcurrency(locals.user.id);
  return json({ entries, concurrency });
};

/**
 * POST /api/queue — create a new queue entry.
 *
 * Body: every field SpawnAgentForm collects plus priority / depends_on /
 * scheduled_for / exclusive.
 *
 * Validation runs at save time so obviously bad data (deleted role, unknown
 * adapter, malformed browser URL) is rejected immediately. The scheduler
 * re-validates at promote time because state can drift between save and run.
 */
export const POST: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
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
  const validation = await validateQueueInput(coerce.value, locals.user.id, locals.supervisor.registry);
  if (!validation.ok) {
    return json({ error: t(locals.locale, validation.errorKey) }, { status: 400 });
  }
  const v = validation.value;

  const id = ulid();
  insertQueueEntry({
    id,
    user_id: locals.user.id,
    role_id: v.role.id,
    repo_id: v.repo.id,
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
    exclusive: coerce.value.exclusive,
    status: 'pending',
    external_source_json: null
  });

  getScheduler().scheduleTick();
  return json({ id }, { status: 201 });
};
