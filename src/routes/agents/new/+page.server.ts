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
import { resolveSha } from '$lib/server/git/agentCommits';
import { getConfig } from '$lib/server/config';
import { slugifyTitle } from '$lib/server/util/slug';
import { isBrowserKind } from '$lib/server/agents/AgentSupervisor';
import { parseBrowserTargetUrl } from '$lib/shared/browserTarget';
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
    const target_url = String(form.get('target_url') ?? '').trim();
    const form_branch = String(form.get('branch') ?? '').trim();
    // Three-state checkbox: 'true' / 'false' / absent. Absent = use adapter's
    // default (the spawn dialog only emits the field for git-enabled adapters).
    const raw_with_worktree = form.get('with_worktree');
    const with_worktree_explicit =
      raw_with_worktree == null ? null : String(raw_with_worktree) === 'true';
    const form_model = String(form.get('model') ?? '').trim() || null;
    const form_permission_mode = String(form.get('permission_mode') ?? '').trim() || null;

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

    // Browser agents need a target URL for the iframe + reverse proxy.
    // Validate up front so a typo doesn't reach the supervisor.
    let browserTarget: { target_url: string; target_port: number } | undefined;
    if (isBrowserKind(role.cli_kind)) {
      const parsed = parseBrowserTargetUrl(target_url);
      if (!parsed.ok) {
        return fail(400, {
          ...fields,
          error: t(locals.locale, `spawn.error.browserUrl.${parsed.error}`)
        });
      }
      browserTarget = { target_url: parsed.url, target_port: parsed.port };
    }

    const cfg = getConfig();
    const wtm = new WorktreeManager(cfg.worktreeRoot);
    // Adapter capability: whether this kind supports worktree creation at all.
    // Browser/shell adapters opt out via `createWorktree: false` in JSONC, in
    // which case the per-spawn checkbox is ignored.
    const adapterSupportsWorktree = locals.supervisor.registry.shouldCreateWorktree(
      role.cli_kind
    );
    // Per-spawn opt-in: default to the adapter capability when the form
    // didn't send the field (the dialog hides the checkbox for non-git kinds).
    const shouldCreate =
      adapterSupportsWorktree &&
      (with_worktree_explicit ?? adapterSupportsWorktree);

    // Resolve the start point for branch creation / checkout. The form value
    // takes precedence; fall back to repo default → project default → 'main'.
    const startPoint =
      form_branch ||
      repo.default_branch ||
      (repo.project_id ? getProject(repo.project_id)?.default_branch : null) ||
      'main';

    const agentId = ulid();

    let worktreePath: string;
    let worktreeBranch: string;
    let baseSha: string | null = null;

    if (shouldCreate) {
      const targetPath = join(cfg.worktreeRoot, slug);
      if (findWorktreeByPath(targetPath) || existsSync(targetPath)) {
        return fail(409, { ...fields, error: t(locals.locale, 'spawn.error.titleTaken') });
      }
      // Branch name is the slug (no `maw/<ulid>` prefix any more). Two agents
      // sharing a task title get `<slug>`, `<slug>-2`, … via the helper so
      // `git worktree add -B` doesn't clobber an existing branch.
      let resolvedBranch: string;
      try {
        resolvedBranch = await WorktreeManager.nextFreeBranchName(repo.path, slug);
      } catch (err) {
        return fail(400, {
          ...fields,
          error: t(locals.locale, 'spawn.error.worktreeFailed', { message: (err as Error).message })
        });
      }
      try {
        const created = await wtm.create({
          repoPath: repo.path,
          agentId,
          branch: resolvedBranch,
          startPoint,
          dirName: slug
        });
        worktreePath = created.path;
        baseSha = created.baseSha;
      } catch (err) {
        return fail(400, {
          ...fields,
          error: t(locals.locale, 'spawn.error.worktreeFailed', { message: (err as Error).message })
        });
      }
      worktreeBranch = resolvedBranch;
    } else if (adapterSupportsWorktree) {
      // User opted out of a dedicated worktree on a git-enabled adapter:
      // check the selected branch out in the repo and run the agent there.
      try {
        await WorktreeManager.checkout(repo.path, startPoint);
      } catch (err) {
        return fail(400, {
          ...fields,
          error: t(locals.locale, 'spawn.error.worktreeFailed', { message: (err as Error).message })
        });
      }
      worktreePath = repo.path;
      worktreeBranch = startPoint;
      baseSha = await resolveSha(repo.path, startPoint);
    } else {
      // Adapter has createWorktree=false (shell, browser, …): run directly
      // in the repo root on whatever branch is already checked out. No
      // throwaway branch, no slug/targetPath collision check — we aren't
      // taking a worktree dir.
      worktreePath = repo.path;
      worktreeBranch = startPoint;
      baseSha = await resolveSha(repo.path, startPoint);
    }

    const worktreeId = ulid();
    insertWorktree({
      id: worktreeId,
      user_id: locals.user.id,
      repo_id: repo.id,
      path: worktreePath,
      branch: worktreeBranch,
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
        baseSha,
        task,
        optionalArgs,
        model: form_model,
        permissionMode: form_permission_mode,
        sourceBranch: worktreeBranch,
        browser: browserTarget
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
