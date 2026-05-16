/**
 * Shared payload helpers for the queue API.
 *
 * `coerceQueueInput` parses raw JSON into a canonical `QueueInput` shape with
 * queue-specific extras (priority, depends_on, scheduled_for, exclusive)
 * alongside the standard spawn fields. `validateQueueInput` runs the shared
 * spawn validator + a depends-on cycle / self-reference check.
 *
 * Both return `{ ok, value }` or `{ ok: false, errorKey: TranslationKey }` so
 * the route layer can plug the key into `t(locals.locale, key)` without
 * carrying SpawnErrorCode → translation mapping around.
 */

import type { TranslationKey } from '$lib/i18n';
import {
  validateSpawnInputs,
  type RawSpawnInputs,
  type SpawnError,
  type ValidatedSpawnInputs
} from '$lib/server/agents/spawnFromInputs';
import type { AdapterRegistry } from '$lib/server/agents/adapters/AdapterRegistry';

export interface QueueInput {
  roleId: string;
  repoId: string;
  taskTitle: string;
  taskBody: string;
  targetUrl: string;
  branch: string;
  /** Three-state: null = use adapter default, true/false = explicit. */
  withWorktreeExplicit: boolean | null;
  model: string | null;
  permissionMode: string | null;
  optionalArgs: Record<string, boolean>;
  priority: number;
  dependsOn: string[];
  /** Unix epoch seconds; null = ASAP. */
  scheduledFor: number | null;
  exclusive: boolean;
  /** User intent: true = eligible for auto-promotion ("queue it"), false =
   *  parked in the task list backlog. */
  queued: boolean;
  /** Optional markdown plan stored alongside the task; appended after the
   *  task body when the agent eventually runs. */
  planMd: string | null;
  /** Optional reference path to the source plan file. Not editable via the
   *  current UI; reserved for future automation. */
  planSourcePath: string | null;
}

export function coerceQueueInput(
  body: unknown
): { ok: true; value: QueueInput } | { ok: false; errorKey: TranslationKey } {
  if (!body || typeof body !== 'object') {
    return { ok: false, errorKey: 'common.error.invalidJson' };
  }
  const b = body as Record<string, unknown>;
  const roleId = String(b.role_id ?? '').trim();
  const repoId = String(b.repo_id ?? '').trim();
  const taskTitle = String(b.task_title ?? '').trim();
  if (!roleId || !repoId) return { ok: false, errorKey: 'spawn.error.roleRepoRequired' };
  if (!taskTitle) return { ok: false, errorKey: 'spawn.error.titleRequired' };

  const taskBody = typeof b.task_body === 'string' ? b.task_body : '';
  const targetUrl = String(b.target_url ?? '').trim();
  const branch = String(b.branch ?? '').trim();
  const withWorktreeExplicit =
    b.with_worktree === undefined || b.with_worktree === null
      ? null
      : Boolean(b.with_worktree);
  const model =
    typeof b.model === 'string' && b.model.trim() !== '' ? b.model.trim() : null;
  const permissionMode =
    typeof b.permission_mode === 'string' && b.permission_mode.trim() !== ''
      ? b.permission_mode.trim()
      : null;
  const optionalArgs: Record<string, boolean> = {};
  if (b.optional_args && typeof b.optional_args === 'object' && !Array.isArray(b.optional_args)) {
    for (const [k, v] of Object.entries(b.optional_args as Record<string, unknown>)) {
      if (typeof v === 'boolean') optionalArgs[k] = v;
    }
  }
  const priority =
    typeof b.priority === 'number' && Number.isFinite(b.priority)
      ? Math.floor(b.priority)
      : 0;
  const dependsOn: string[] = [];
  if (Array.isArray(b.depends_on)) {
    for (const dep of b.depends_on) {
      if (typeof dep === 'string' && dep.trim() !== '') dependsOn.push(dep.trim());
    }
  }
  let scheduledFor: number | null = null;
  if (typeof b.scheduled_for === 'number' && Number.isFinite(b.scheduled_for)) {
    scheduledFor = Math.floor(b.scheduled_for);
    if (scheduledFor <= 0) scheduledFor = null;
  }
  const exclusive = Boolean(b.exclusive);

  // queued: default false (Backlog). The spawn dialog's "Run" submit button
  // is the only path that POSTs queued=true. Older callers that never set
  // the flag land in the backlog by design.
  const queued = b.queued === undefined ? false : Boolean(b.queued);
  const planMd =
    typeof b.plan_md === 'string' && b.plan_md.trim() !== '' ? b.plan_md : null;
  const planSourcePath =
    typeof b.plan_source_path === 'string' && b.plan_source_path.trim() !== ''
      ? b.plan_source_path.trim()
      : null;

  return {
    ok: true,
    value: {
      roleId,
      repoId,
      taskTitle,
      taskBody,
      targetUrl,
      branch,
      withWorktreeExplicit,
      model,
      permissionMode,
      optionalArgs,
      priority,
      dependsOn,
      scheduledFor,
      exclusive,
      queued,
      planMd,
      planSourcePath
    }
  };
}

export async function validateQueueInput(
  input: QueueInput,
  userId: string,
  registry: AdapterRegistry
): Promise<
  | { ok: true; value: ValidatedSpawnInputs }
  | { ok: false; errorKey: TranslationKey }
> {
  const raw: RawSpawnInputs = {
    roleId: input.roleId,
    repoId: input.repoId,
    taskTitle: input.taskTitle,
    taskBody: input.taskBody,
    targetUrl: input.targetUrl,
    branch: input.branch,
    withWorktreeExplicit: input.withWorktreeExplicit,
    model: input.model,
    permissionMode: input.permissionMode,
    optionalArgs: input.optionalArgs,
    planMd: input.planMd
  };
  // Branch existence is NOT verified at save time — the user picked from a
  // dropdown of branches that existed when the dialog opened, and the
  // scheduler re-validates at promote time. Saves stay snappy.
  const validation = await validateSpawnInputs(raw, userId, registry);
  if (!validation.ok) {
    return { ok: false, errorKey: spawnErrorToTranslationKey(validation.error) };
  }
  return { ok: true, value: validation.value };
}

export function spawnErrorToTranslationKey(err: SpawnError): TranslationKey {
  switch (err.code) {
    case 'roleRepoRequired':
      return 'spawn.error.roleRepoRequired';
    case 'titleRequired':
      return 'spawn.error.titleRequired';
    case 'titleUnslugifiable':
      return 'spawn.error.titleUnslugifiable';
    case 'unknownRole':
      return 'spawn.error.unknownRole';
    case 'unknownRepo':
      return 'spawn.error.unknownRepo';
    case 'unknownAdapter':
      return 'spawn.error.unknownCliKind';
    case 'browserUrlEmpty':
      return 'spawn.error.browserUrl.empty';
    case 'browserUrlInvalid':
      return 'spawn.error.browserUrl.invalid';
    case 'browserUrlScheme':
      return 'spawn.error.browserUrl.scheme';
    case 'browserUrlHost':
      return 'spawn.error.browserUrl.host';
    case 'browserUrlPort':
      return 'spawn.error.browserUrl.port';
    case 'titleTaken':
      return 'spawn.error.titleTaken';
    case 'branchMissing':
    case 'worktreeFailed':
      return 'spawn.error.worktreeFailed';
    case 'spawnFailed':
      return 'spawn.error.spawnFailed';
  }
}
