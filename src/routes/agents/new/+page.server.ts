import { fail, redirect } from '@sveltejs/kit';
import { ulid } from 'ulid';
import type { Actions, PageServerLoad } from './$types';
import {
  getProject,
  getRepo,
  getRole,
  insertTask,
  insertWorktree,
  listProjects,
  listReposForProject,
  listRoles,
  updateAgentCurrentTask
} from '$lib/server/db/queries';
import { WorktreeManager } from '$lib/server/git/WorktreeManager';
import { getConfig } from '$lib/server/config';
import type { RepoRow } from '$lib/server/db/types';

interface RepoOption {
  id: string;
  path: string;
  projectName: string;
}

function loadRepoOptions(userId: string): RepoOption[] {
  const options: RepoOption[] = [];
  for (const project of listProjects(userId)) {
    for (const repo of listReposForProject(project.id)) {
      options.push({ id: repo.id, path: repo.path, projectName: project.name });
    }
  }
  return options;
}

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return {
    roles: listRoles(locals.user.id),
    repos: loadRepoOptions(locals.user.id),
    projects: listProjects(locals.user.id),
    cliKinds: locals.supervisor.registry.list()
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
      return fail(400, { ...fields, error: 'Role and repo are required' });
    }

    const role = getRole(role_id);
    if (!role || role.user_id !== locals.user.id) {
      return fail(400, { ...fields, error: 'Unknown role' });
    }
    const repo: RepoRow | undefined = getRepo(repo_id);
    if (!repo || repo.user_id !== locals.user.id) {
      return fail(400, { ...fields, error: 'Unknown repo' });
    }

    const project = getProject(repo.project_id);
    if (!project) {
      return fail(400, { ...fields, error: 'Repo is orphaned (no project)' });
    }

    // Pre-generate agent id so worktree dir, branch and agent row stay in lock-step.
    const agentId = ulid();
    const branch = `maw/${agentId}`;

    const cfg = getConfig();
    const wtm = new WorktreeManager(cfg.worktreeRoot);

    let worktreePath: string;
    try {
      worktreePath = await wtm.create({
        repoPath: repo.path,
        agentId,
        branch,
        startPoint: project.default_branch
      });
    } catch (err) {
      return fail(400, {
        ...fields,
        error: `Worktree creation failed: ${(err as Error).message}`
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

    const task = task_title || task_body ? { title: task_title, body: task_body } : null;

    try {
      await locals.supervisor.spawn({
        agentId,
        userId: locals.user.id,
        roleId: role.id,
        repoId: repo.id,
        repoPath: repo.path,
        worktreeId,
        worktreePath,
        task
      });
    } catch (err) {
      return fail(500, {
        ...fields,
        error: `Spawn failed: ${(err as Error).message}`
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
