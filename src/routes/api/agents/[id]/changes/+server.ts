/**
 * GET /api/agents/:id/changes → ChangesResponse
 *
 * Backs the agent-window kebab "Show Changes" action. Returns the agent's diff
 * split into two sections — committed (`base_sha..HEAD`) and uncommitted
 * (working tree) — as structured JSON the client renders for mobile. `aiEnabled`
 * tells the client whether the Q&A panel is usable.
 *
 * Owner-only, same auth pattern as the sibling /plan and /log routes. No CSRF (GET).
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent, getWorktree } from '$lib/server/db/queries';
import { getAgentChanges, type AgentChanges } from '$lib/server/git/agentDiff';
import { isConfigured } from '$lib/server/llm';

export interface ChangesResponse extends AgentChanges {
  aiEnabled: boolean;
}

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  const wt = getWorktree(agent.worktree_id);
  if (!wt) throw error(404, 'Worktree not found');

  const changes = await getAgentChanges(wt.path, agent.base_sha);
  return json({ ...changes, aiEnabled: isConfigured() } satisfies ChangesResponse);
};
