/**
 * GET /api/agents/:id/plan          → { dir, globalDir, files: PlanFileSummary[] }
 * GET /api/agents/:id/plan?file=X&source=local|global  → { name, html }
 *
 * Backs the agent-window kebab "Show Plan" action. The list shape is
 * always returned for the bare GET (even when empty — the client
 * renders an empty state including both resolved plans directories).
 * The `?file=` form returns sanitized HTML rendered server-side.
 *
 * `source` defaults to `local` for backward compat; `global` reads from
 * `~/.claude/plans/`. Anything else → 400 `invalid_source`.
 *
 * Owner-only, same auth pattern as the sibling /log route. No CSRF
 * (GET).
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent, getWorktree } from '$lib/server/db/queries';
import {
  displayDir,
  listAgentPlans,
  renderAgentPlan,
  resolvePlansDir,
  type PlanSource
} from '$lib/server/plans/agentPlans';

export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  const wt = getWorktree(agent.worktree_id);
  if (!wt) throw error(404, 'Worktree not found');

  const fileParam = url.searchParams.get('file');

  if (fileParam !== null) {
    const sourceParam = url.searchParams.get('source') ?? 'local';
    if (sourceParam !== 'local' && sourceParam !== 'global') {
      return json({ code: 'invalid_source' }, { status: 400 });
    }
    const source = sourceParam as PlanSource;
    // For global renders we don't need to read the worktree's settings —
    // the path is fully determined by source. Cheaper + belt-and-braces.
    const plansDir = source === 'global' ? '' : await resolvePlansDir(wt.path);
    let rendered;
    try {
      rendered = await renderAgentPlan(wt.path, plansDir, fileParam, source);
    } catch (err) {
      if ((err as Error).message === 'invalid_filename') {
        return json({ code: 'invalid_filename' }, { status: 400 });
      }
      throw err;
    }
    if (!rendered) return json({ code: 'plan_not_found' }, { status: 404 });
    return json({ name: rendered.name, html: rendered.html });
  }

  const plansDir = await resolvePlansDir(wt.path);
  const files = await listAgentPlans(
    wt.path,
    plansDir,
    agent.base_sha,
    agent.created_at
  );
  return json({
    dir: displayDir('local', plansDir),
    globalDir: displayDir('global', plansDir),
    files
  });
};
