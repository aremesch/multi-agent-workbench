/**
 * DELETE /api/agents/:id[?removeWorktree=1]
 *
 * Removes an agent entirely. Flow:
 *   1. Verify ownership.
 *   2. Ask the supervisor to stop any live runtime + kill the tmux session.
 *   3. Optionally remove the git worktree from disk (requires the repo row
 *      and the worktree row to be reachable).
 *   4. Delete the agent row; CASCADE on 001_init.sql takes agent_runs, tasks,
 *      events, messages, alerts, llm_oversight_verdicts, terminal_log.
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  deleteAgent,
  getAgent,
  getRepo,
  getWorktree,
  updateWorktreeStatus
} from '$lib/server/db/queries';
import { WorktreeManager } from '$lib/server/git/WorktreeManager';
import { getConfig } from '$lib/server/config';
import { verifyCsrf } from '$lib/server/auth/csrf';

export const DELETE: RequestHandler = async ({ locals, params, url, cookies, request }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  const removeWorktree = url.searchParams.get('removeWorktree') === '1';

  // 1. Stop the runtime + kill tmux. Idempotent.
  try {
    await locals.supervisor.kill(agent.id);
  } catch (err) {
    console.error('[delete-agent] kill failed', err);
  }

  // 2. Optionally remove the worktree from disk.
  if (removeWorktree) {
    const worktree = getWorktree(agent.worktree_id);
    const repo = worktree ? getRepo(worktree.repo_id) : undefined;
    if (worktree && repo) {
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
  }

  // 3. Delete the row. CASCADE handles dependent tables.
  deleteAgent(agent.id);

  return new Response(null, { status: 204 });
};
