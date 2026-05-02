/**
 * GET /api/agents/:id/plan          → { dir, files: PlanFileSummary[] }
 * GET /api/agents/:id/plan?file=X   → { name, html }
 *
 * Backs the agent-window kebab "Show Plan" action. The list shape is
 * always returned for the bare GET (even when empty — the client
 * renders an empty state including the resolved plans directory). The
 * `?file=` form returns sanitized HTML rendered server-side.
 *
 * Owner-only, same auth pattern as the sibling /log route. No CSRF
 * (GET).
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent, getWorktree } from '$lib/server/db/queries';
import {
  listAgentPlans,
  renderAgentPlan,
  resolvePlansDir
} from '$lib/server/plans/agentPlans';

export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  const wt = getWorktree(agent.worktree_id);
  if (!wt) throw error(404, 'Worktree not found');

  const plansDir = await resolvePlansDir(wt.path);
  const fileParam = url.searchParams.get('file');

  if (fileParam !== null) {
    let rendered;
    try {
      rendered = await renderAgentPlan(wt.path, plansDir, fileParam);
    } catch (err) {
      if ((err as Error).message === 'invalid_filename') {
        return json({ code: 'invalid_filename' }, { status: 400 });
      }
      throw err;
    }
    if (!rendered) return json({ code: 'plan_not_found' }, { status: 404 });
    return json({ name: rendered.name, html: rendered.html });
  }

  const files = await listAgentPlans(wt.path, plansDir, agent.base_sha);
  return json({ dir: plansDir, files });
};
