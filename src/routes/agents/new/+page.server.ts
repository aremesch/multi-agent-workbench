import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { t, type TranslationKey } from '$lib/i18n';
import {
  getSpawnDefaultsAll,
  listReposWithProjectForUser,
  listRoles
} from '$lib/server/db/queries';
import {
  performSpawn,
  validateSpawnInputs,
  type RawSpawnInputs,
  type SpawnError
} from '$lib/server/agents/spawnFromInputs';

interface RepoOption {
  id: string;
  path: string;
  projectName: string | null;
}

function loadRepoOptions(userId: string): RepoOption[] {
  return listReposWithProjectForUser(userId).map((r) => ({
    id: r.id,
    path: r.path,
    projectName: r.project_name
  }));
}

/**
 * Map the spawn pipeline's discriminated error codes onto the form action's
 * i18n keys. Centralized so the queue API can pick its own mapping without
 * the pipeline owning either.
 */
function spawnErrorToTranslationKey(err: SpawnError): TranslationKey {
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
      // No dedicated key; reuse the role error since the user picked a role
      // whose cli_kind has no loaded adapter — both surface as "this role
      // can't be used right now."
      return 'spawn.error.unknownRole';
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

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  const cliKinds = locals.supervisor.registry.list();
  return {
    roles: listRoles(locals.user.id),
    repos: loadRepoOptions(locals.user.id),
    cliKinds,
    spawnDefaults: getSpawnDefaultsAll(
      locals.user.id,
      cliKinds.map((k) => k.kind)
    )
  };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    if (!locals.user) throw redirect(303, '/login');
    const form = await request.formData();
    const role_id = String(form.get('role_id') ?? '').trim();
    const repo_id = String(form.get('repo_id') ?? '').trim();
    const task_title = String(form.get('task_title') ?? '').trim();
    const task_body = String(form.get('task_body') ?? '');
    const target_url = String(form.get('target_url') ?? '').trim();
    const form_branch = String(form.get('branch') ?? '').trim();
    // Three-state checkbox: 'true' / 'false' / absent. Absent = use adapter's
    // default (the spawn dialog only emits the field for git-enabled adapters).
    const raw_with_worktree = form.get('with_worktree');
    const with_worktree_explicit =
      raw_with_worktree == null ? null : String(raw_with_worktree) === 'true';
    const form_model = String(form.get('model') ?? '').trim() || null;
    const form_permission_mode = String(form.get('permission_mode') ?? '').trim() || null;

    // Parse optionalArgs[*] toggles.
    const optionalArgs: Record<string, boolean> = {};
    for (const [key, val] of form.entries()) {
      const m = /^optionalArgs\[(.+)\]$/.exec(key);
      if (m?.[1]) optionalArgs[m[1]] = val === 'true';
    }

    // Field bag re-rendered into the form on validation failure so the user
    // doesn't lose what they typed.
    const fields = {
      role_id,
      repo_id,
      task_title,
      task_body,
      target_url,
      branch: form_branch,
      model: form_model,
      permission_mode: form_permission_mode
    };

    const raw: RawSpawnInputs = {
      roleId: role_id,
      repoId: repo_id,
      taskTitle: task_title,
      taskBody: task_body,
      targetUrl: target_url,
      branch: form_branch,
      withWorktreeExplicit: with_worktree_explicit,
      model: form_model,
      permissionMode: form_permission_mode,
      optionalArgs
    };

    const validation = await validateSpawnInputs(raw, locals.user.id, locals.supervisor.registry);
    if (!validation.ok) {
      const key = spawnErrorToTranslationKey(validation.error);
      const params = validation.error.message ? { message: validation.error.message } : undefined;
      const status = validation.error.code === 'titleTaken' ? 409 : 400;
      return fail(status, { ...fields, error: t(locals.locale, key, params) });
    }

    const result = await performSpawn(validation.value, locals.user.id, locals.supervisor);
    if (!result.ok) {
      const key = spawnErrorToTranslationKey(result.error);
      const params = result.error.message ? { message: result.error.message } : undefined;
      const status =
        result.error.code === 'titleTaken' ? 409 :
        result.error.code === 'spawnFailed' ? 500 : 400;
      if (result.error.code === 'spawnFailed') {
        return fail(status, {
          ...fields,
          error: `${t(locals.locale, key)}: ${result.error.message ?? ''}`
        });
      }
      return fail(status, { ...fields, error: t(locals.locale, key, params) });
    }

    throw redirect(303, `/agents/${result.agentId}`);
  }
};
