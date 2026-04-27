/**
 * POST /api/agents/:id/stop
 *
 * Transition a live agent into `exited`. Used by the browser-agent
 * BrowserView's "Stop session" button — browser agents don't have a tmux
 * session a user could close from the inside, so they need an explicit
 * archive trigger from the UI. Also a clean fit for any future "kill from
 * dashboard" affordance on CLI agents.
 *
 * Idempotent gate: a 409 is returned when the agent is already archived
 * (exited/crashed) so accidental double-clicks don't churn through
 * supervisor.kill() / Tmux.killSession() again.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent } from '$lib/server/db/queries';
import { verifyCsrf } from '$lib/server/auth/csrf';

const ARCHIVED_STATUSES = new Set(['exited', 'crashed']);

export const POST: RequestHandler = async ({ locals, params, cookies, request }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  if (ARCHIVED_STATUSES.has(agent.status)) {
    return json({ code: 'already_archived', status: agent.status }, { status: 409 });
  }

  try {
    await locals.supervisor.kill(agent.id);
  } catch (err) {
    console.error('[stop-agent] kill failed', err);
    return json({ code: 'kill_failed', error: (err as Error).message }, { status: 500 });
  }

  return json({ status: 'exited' });
};
