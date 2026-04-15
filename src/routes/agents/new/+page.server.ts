import { fail, redirect } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { Actions, PageServerLoad } from './$types';
import { t } from '$lib/i18n';
import {
  findWorktreeByPath,
  getProject,
  getRepo,
  getRole,
  getSpawnDefaultsAll,
  insertTask,
  insertWorktree,
  listReposWithProjectForUser,
  listRoles,
  updateAgentCurrentTask
} from '$lib/server/db/queries';
import { WorktreeManager } from '$lib/server/git/WorktreeManager';
import { getConfig } from '$lib/server/config';
import { slugifyTitle } from '$lib/server/util/slug';
import type { RepoRow } from '$lib/server/db/types';

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

    const fields = { role_id, repo_id, task_title, task_body };

    if (!role_id || !repo_id) {
      return fail(400, { ...fields, error: t(locals.locale, 'spawn.error.roleRepoRequired') });
    }
    if (!task_title) {
      return fail(400, { ...fields, error: t(locals.locale, 'spawn.error.titleRequired') });
    }

    const slug = slugifyTitle(task_title);
    if (!slug) {
      return fail(400, { ...fields, error: t(locals.locale, 'spawn.error.titleUnslugifiable') });
    }

    const role = getRole(role_id);
    if (!role || role.user_id !== locals.user.id) {
      return fail(400, { ...fields, error: t(locals.locale, 'spawn.error.unknownRole') });
    }
    const repo: RepoRow | undefined = getRepo(repo_id);
    if (!repo || repo.user_id !== locals.user.id) {
      return fail(400, { ...fields, error: t(locals.locale, 'spawn.error.unknownRepo') });
    }

    const startPoint =
      repo.default_branch ??
      (repo.project_id ? getProject(repo.project_id)?.default_branch : null) ??
      'main';

    // Pre-generate agent id so the branch name + agent row stay in lock-step;
    // branch stays ULID-based so it's globally unique even if titles are
    // reused across repos.
    const agentId = ulid();
    const branch = `maw/${agentId}`;

    const cfg = getConfig();
    const targetPath = join(cfg.worktreeRoot, slug);

    if (findWorktreeByPath(targetPath) || existsSync(targetPath)) {
      return fail(409, { ...fields, error: t(locals.locale, 'spawn.error.titleTaken') });
    }

    const wtm = new WorktreeManager(cfg.worktreeRoot);

    let worktreePath: string;
    try {
      worktreePath = await wtm.create({
        repoPath: repo.path,
        agentId,
        branch,
        startPoint,
        dirName: slug
      });
    } catch (err) {
      return fail(400, {
        ...fields,
        error: t(locals.locale, 'spawn.error.worktreeFailed', { message: (err as Error).message })
      });
    }

    const worktreeId = ulid();
    insertWorktree({
      id: worktreeId,
      user_id: locals.user.id,
      repo_id: repo.id,
      path: worktreePath,
      branch,
      status: 'active'
    });

    const task = { title: task_title, body: task_body };

    // Parse optionalArgs[*] toggles from form data.
    const optionalArgs: Record<string, boolean> = {};
    for (const [key, val] of form.entries()) {
      const m = /^optionalArgs\[(.+)\]$/.exec(key);
      if (m?.[1]) optionalArgs[m[1]] = val === 'true';
    }

    try {
      await locals.supervisor.spawn({
        agentId,
        userId: locals.user.id,
        roleId: role.id,
        repoId: repo.id,
        repoPath: repo.path,
        worktreeId,
        worktreePath,
        task,
        optionalArgs
      });
    } catch (err) {
      return fail(500, {
        ...fields,
        error: `${t(locals.locale, 'spawn.error.spawnFailed')}: ${(err as Error).message}`
      });
    }

    // Persist the task so the dashboard caption can render it. The agent row
    // is inserted inside supervisor.spawn(), so we can now safely FK back to
    // it and set current_task_id — which listAgentCardsForUser joins on.
    if (task) {
      const taskId = ulid();
      insertTask({
        id: taskId,
        user_id: locals.user.id,
        agent_id: agentId,
        title: task.title,
        body: task.body,
        status: 'active',
        assigned_by_agent_id: null
      });
      updateAgentCurrentTask(agentId, taskId);
    }

    throw redirect(303, `/agents/${agentId}`);
  }
};
