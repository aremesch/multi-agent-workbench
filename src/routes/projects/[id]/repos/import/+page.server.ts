import { error, fail, redirect } from '@sveltejs/kit';
import { ulid } from 'ulid';
import type { Actions, PageServerLoad } from './$types';
import {
  getProject,
  insertRepo,
  listReposForProject,
  setProjectWorkspaceRoot
} from '$lib/server/db/queries';
import { BrowseError, listGitRepoChildren } from '$lib/server/fs/browse';
import { getFsBrowseRoot } from '$lib/server/config';
import { WorktreeManager } from '$lib/server/git/WorktreeManager';
import { resolveGitIdentity } from '$lib/server/user/gitIdentity';
import { t, type Locale } from '$lib/i18n';

/** Map a BrowseError code to an existing localized message key. */
function browseErrorMessage(locale: Locale, err: BrowseError): string {
  switch (err.code) {
    case 'outside_root':
      return t(locale, 'picker.error.outsideRoot');
    case 'not_found':
      return t(locale, 'common.error.pathNotExist');
    case 'not_directory':
      return t(locale, 'common.error.pathNotDir');
    default:
      return t(locale, 'picker.error.load');
  }
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
  if (!locals.user) throw redirect(303, '/login');
  const project = getProject(params.id);
  if (!project) throw error(404, t(locals.locale, 'common.error.projectNotFound'));
  if (project.user_id !== locals.user.id) throw error(403, t(locals.locale, 'common.error.forbidden'));

  const workspace = url.searchParams.get('workspace');
  const empty: string[] = [];
  if (!workspace) {
    return { project, workspace: null, repos: null, registeredPaths: empty, browseError: null };
  }

  try {
    const { path, children } = listGitRepoChildren(workspace, getFsBrowseRoot());
    const registeredPaths = listReposForProject(project.id).map((r) => r.path);
    return {
      project,
      workspace: path,
      repos: children,
      registeredPaths,
      browseError: null
    };
  } catch (err) {
    if (err instanceof BrowseError) {
      return {
        project,
        workspace,
        repos: null,
        registeredPaths: empty,
        browseError: browseErrorMessage(locals.locale, err)
      };
    }
    throw err;
  }
};

export const actions: Actions = {
  default: async ({ request, locals, params }) => {
    if (!locals.user) throw redirect(303, '/login');
    const project = getProject(params.id);
    if (!project) throw error(404, t(locals.locale, 'common.error.projectNotFound'));
    if (project.user_id !== locals.user.id) throw error(403, t(locals.locale, 'common.error.forbidden'));

    const form = await request.formData();
    const workspace = String(form.get('workspace_root') ?? '').trim();
    const selected = form.getAll('paths').map((p) => String(p).trim()).filter(Boolean);

    if (!workspace) {
      return fail(400, { workspace: null, error: t(locals.locale, 'common.error.pathRequired') });
    }

    // Re-discover the real git children server-side — never trust the client's
    // path list. Only paths that are still genuine git children of the chosen
    // workspace folder may be imported.
    let discovered: string[];
    let resolvedWorkspace: string;
    try {
      const res = listGitRepoChildren(workspace, getFsBrowseRoot());
      resolvedWorkspace = res.path;
      discovered = res.children.map((c) => c.path);
    } catch (err) {
      if (err instanceof BrowseError) {
        return fail(400, { workspace, error: browseErrorMessage(locals.locale, err) });
      }
      throw err;
    }

    const discoveredSet = new Set(discovered);
    const alreadyRegistered = new Set(listReposForProject(project.id).map((r) => r.path));

    const toImport = selected.filter(
      (p) => discoveredSet.has(p) && !alreadyRegistered.has(p)
    );
    if (toImport.length === 0) {
      return fail(400, { workspace: resolvedWorkspace, error: t(locals.locale, 'import.error.noneSelected') });
    }

    const identity = resolveGitIdentity(locals.user.id, locals.user.username);
    const imported: string[] = [];
    const errors: { path: string; error: string }[] = [];

    for (const path of toImport) {
      try {
        const normalized = await WorktreeManager.ensureDefaultBranch(
          path,
          project.default_branch,
          identity
        );
        if (normalized.kind === 'no_master') {
          const where = normalized.current ? ` (currently on '${normalized.current}')` : '';
          errors.push({
            path,
            error: t(locals.locale, 'common.error.noBranch', { branch: project.default_branch }) + where
          });
          continue;
        }
      } catch (err) {
        errors.push({
          path,
          error: t(locals.locale, 'common.error.gitInitFailed', { message: (err as Error).message })
        });
        continue;
      }

      insertRepo({
        id: ulid(),
        user_id: locals.user.id,
        project_id: project.id,
        path,
        origin_url: null,
        default_branch: project.default_branch
      });
      imported.push(path);
    }

    // Record the workspace root once we've successfully imported at least one
    // repo and the project doesn't already have one.
    if (imported.length > 0 && !project.workspace_root) {
      setProjectWorkspaceRoot(project.id, locals.user.id, resolvedWorkspace);
    }

    // Clean run → back to the project page. Partial failure → redisplay with a
    // per-path error list so the user can see what was skipped.
    if (errors.length === 0) {
      throw redirect(303, `/projects/${project.id}`);
    }
    return fail(400, { workspace: resolvedWorkspace, imported, errors });
  }
};
