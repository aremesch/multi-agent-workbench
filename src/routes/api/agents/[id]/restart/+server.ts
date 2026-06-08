/**
 * POST /api/agents/:id/restart
 *
 * Revive a crashed agent in place — reuses the same agent row, worktree,
 * branch and (for claude-code) CLI session, adding a fresh run. Only
 * permitted for status='crashed' agents; everything else returns 409.
 *
 * Smart resume: when a claude-code transcript survived the crash the agent
 * relaunches with `claude --resume <id>` (full prior context); otherwise it
 * re-spawns fresh, re-feeding the original task body. The `mode` field of the
 * success response tells the client which path was taken.
 *
 * Failure codes (409 unless noted):
 *   not_crashed        — agent is not in the crashed state.
 *   worktree_gone      — the worktree row is missing / tombstoned.
 *   branch_gone        — worktree dir and source branch are both gone.
 *   unknown_kind       — no adapter registered for the agent's cli_kind.
 *   browser_unsupported— browser agents survive restarts on their own.
 *   launch_failed (500)— the CLI died before pipe-pane attached; the row is
 *                        left at 'crashed' so the user can retry.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent } from '$lib/server/db/queries';
import { verifyCsrf } from '$lib/server/auth/csrf';

export const POST: RequestHandler = async ({ locals, params, cookies, request }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  if (agent.status !== 'crashed') {
    return json({ code: 'not_crashed', status: agent.status }, { status: 409 });
  }

  const result = await locals.supervisor.restart(agent.id);
  if (!result.ok) {
    const status = result.code === 'launch_failed' ? 500 : 409;
    return json({ code: result.code, message: result.message }, { status });
  }
  return json({ ok: true, mode: result.mode, agentId: agent.id });
};
