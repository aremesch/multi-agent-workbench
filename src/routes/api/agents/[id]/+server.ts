/**
 * DELETE /api/agents/:id[?removeWorktree=1][&force=1]
 *
 * Removes an agent entirely. Only permitted for archived agents (status
 * exited or crashed) — delete on a live agent returns 409 not_archived.
 *
 * When removeWorktree=1 and force!=1, the worktree is inspected first; if
 * there are uncommitted changes, responds 409 worktree_dirty with the list
 * of changed files so the UI can ask the user to confirm losing them.
 * With force=1 the worktree is removed unconditionally.
 *
 * Flow on success:
 *   1. Verify ownership + archived status.
 *   2. Dirty-gate the worktree (unless force=1 or removeWorktree=0).
 *   3. Ask the supervisor to stop any live runtime + kill the tmux session.
 *   4. Optionally remove the git worktree from disk.
 *   5. Delete the agent row; CASCADE on 001_init.sql takes agent_runs, tasks,
 *      events, messages, alerts, llm_oversight_verdicts, terminal_log.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  deleteAgent,
  getAgent,
  getRepo,
  getWorktree,
  updateWorktreeStatus
} from '$lib/server/db/queries';
import { WorktreeManager } from '$lib/server/git/WorktreeManager';
import { isWorktreeDirty } from '$lib/server/git/worktreeStatus';
import { getConfig } from '$lib/server/config';
import { verifyCsrf } from '$lib/server/auth/csrf';

const ARCHIVED_STATUSES = new Set(['exited', 'crashed']);

export const DELETE: RequestHandler = async ({ locals, params, url, cookies, request }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  if (!ARCHIVED_STATUSES.has(agent.status)) {
    return json({ code: 'not_archived', status: agent.status }, { status: 409 });
  }

  const removeWorktree = url.searchParams.get('removeWorktree') === '1';
  const force = url.searchParams.get('force') === '1';

  const worktree = getWorktree(agent.worktree_id);
  const repo = worktree ? getRepo(worktree.repo_id) : undefined;

  // 1. Dirty gate. Only runs when the caller wants the worktree gone and
  // hasn't already confirmed losing changes. Already-removed worktrees are
  // treated as clean (there's nothing to check).
  if (removeWorktree && !force && worktree && worktree.status !== 'removed' && repo) {
    const check = await isWorktreeDirty(worktree.path);
    if (check.dirty) {
      return json(
        { code: 'worktree_dirty', changedFiles: check.files },
        { status: 409 }
      );
    }
  }

  // 2. Stop the runtime + kill tmux. Idempotent.
  try {
    await locals.supervisor.kill(agent.id);
  } catch (err) {
    console.error('[delete-agent] kill failed', err);
  }

  // 3. Optionally remove the worktree from disk.
  if (removeWorktree && worktree && repo) {
    try {
      const wtm = new WorktreeManager(getConfig().worktreeRoot);
      await wtm.remove({ repoPath: repo.path, wtPath: worktree.path, force: true });
      updateWorktreeStatus(worktree.id, 'removed');
    } catch (err) {
      console.error('[delete-agent] worktree remove failed', err);
      // Fall through — still delete the agent row so it stops haunting
      // the dashboard. The orphaned worktree can be cleaned up manually.
    }
  }

  // 4. Delete the row. CASCADE handles dependent tables.
  deleteAgent(agent.id);

  return new Response(null, { status: 204 });
};
