import { json } from '@sveltejs/kit';
import { basename } from 'node:path';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import {
  countAgentsForRepo,
  countOpenQueueEntriesForRepo,
  deleteRepo,
  getRepo,
  listWorktreesForRepo,
  updateRepo
} from '$lib/server/db/queries';
import { WorktreeManager } from '$lib/server/git/WorktreeManager';
import { getConfig } from '$lib/server/config';
import { t } from '$lib/i18n';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  const repo = getRepo(params.id);
  if (!repo || repo.user_id !== locals.user.id) {
    return json({ error: t(locals.locale, 'common.error.repoNotFound') }, { status: 404 });
  }
  return json({
    id: repo.id,
    path: repo.path,
    origin_url: repo.origin_url,
    default_branch: repo.default_branch,
    projectName: basename(repo.path)
  });
};

export const PUT: RequestHandler = async ({ locals, params, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const origin_raw = b.origin_url;
  const origin_url =
    origin_raw === null || origin_raw === undefined
      ? null
      : String(origin_raw).trim() || null;

  const ok = updateRepo({ id: params.id, user_id: locals.user.id, origin_url });
  if (!ok) return json({ error: t(locals.locale, 'common.error.repoNotFound') }, { status: 404 });
  return json({ ok: true, id: params.id, origin_url });
};

/**
 * DELETE /api/repos/:id
 *
 * Removes a repo from the workbench. Only the MAW record and any MAW-created
 * worktrees (under worktreeRoot) are removed — the user's real repo directory
 * at repo.path is never touched.
 *
 * Guarded: a repo may only be deleted when it has NO agents (live or archived)
 * and NO open queue entries. Both agents.repo_id and queue_entries.repo_id are
 * ON DELETE RESTRICT, so this is enforced by the DB too; the explicit 409 lets
 * the UI explain why. worktrees.repo_id is ON DELETE CASCADE, so worktree rows
 * are removed automatically once the repo row is gone.
 */
export const DELETE: RequestHandler = async ({ locals, params, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });

  const repo = getRepo(params.id);
  if (!repo || repo.user_id !== locals.user.id) {
    return json({ error: t(locals.locale, 'common.error.repoNotFound') }, { status: 404 });
  }

  const agents = countAgentsForRepo(locals.user.id, params.id);
  const openTasks = countOpenQueueEntriesForRepo(locals.user.id, params.id);
  if (agents > 0 || openTasks > 0) {
    return json({ code: 'repo_in_use', agents, openTasks }, { status: 409 });
  }

  // Best-effort cleanup of MAW-created worktree directories on disk. The repo
  // has no agents, so there's no tmux to kill; worktree rows may still linger
  // after their agents were deleted. Skip tombstones and any worktree that
  // shares the repo root (no-worktree spawns). Failures are logged, not fatal.
  const wtm = new WorktreeManager(getConfig().worktreeRoot);
  for (const wt of listWorktreesForRepo(params.id)) {
    if (wt.status === 'removed' || wt.path === repo.path) continue;
    try {
      await wtm.remove({ repoPath: repo.path, wtPath: wt.path, force: true });
    } catch (err) {
      console.error('[delete-repo] worktree remove failed', err);
    }
  }

  const ok = deleteRepo(params.id, locals.user.id);
  if (!ok) return json({ error: t(locals.locale, 'common.error.repoNotFound') }, { status: 404 });
  return new Response(null, { status: 204 });
};
