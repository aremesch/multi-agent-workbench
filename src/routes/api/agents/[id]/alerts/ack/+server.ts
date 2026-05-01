/**
 * POST /api/agents/:id/alerts/ack
 *
 * Mark every unacked alert for the agent as acknowledged. Called by the
 * dashboard when the user opens the agent's terminal modal — both to
 * dismiss the foreground toast and to keep the 30-second dedup window
 * in `AgentRuntime.maybeAlert` from suppressing legitimate follow-ups
 * once the user has seen the prior prompt.
 *
 * Owner-scoped (the helper validates `user_id`); a misaddressed request
 * for another user's agent silently changes 0 rows. Idempotent — same
 * 200 response either way.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { acknowledgeAgentAlerts, getAgent } from '$lib/server/db/queries';

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  const acked = acknowledgeAgentAlerts(agent.id, locals.user.id);
  return json({ acked });
};
