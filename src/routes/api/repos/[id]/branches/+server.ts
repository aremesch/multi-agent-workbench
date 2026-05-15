import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepo } from '$lib/server/db/queries';
import { WorktreeManager } from '$lib/server/git/WorktreeManager';
import { t } from '$lib/i18n';

/**
 * GET /api/repos/:id/branches — returns the list of local branches in a repo
 * plus the one currently checked out. Used by the spawn dialog's branch
 * dropdown when the selected role is git-enabled.
 *
 * Owner-scoped: 404 (not 403) for repos owned by other users to avoid
 * exposing existence. Local branches only in v1; remote (origin/foo)
 * branches require an explicit fetch + branch-from-remote flow we haven't
 * built yet.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  const repo = getRepo(params.id);
  if (!repo || repo.user_id !== locals.user.id) {
    return json({ error: t(locals.locale, 'common.error.repoNotFound') }, { status: 404 });
  }

  try {
    const { branches, current } = await WorktreeManager.listBranches(repo.path);
    return json({ branches, current });
  } catch (err) {
    return json(
      {
        error: t(locals.locale, 'spawn.error.branchListFailed', {
          message: (err as Error).message
        })
      },
      { status: 500 }
    );
  }
};
