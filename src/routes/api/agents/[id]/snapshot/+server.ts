/**
 * GET /api/agents/:id/snapshot
 *
 * Returns a ~50-line text snapshot of the agent's tmux pane for the dashboard
 * thumbnail card. ANSI escapes stripped server-side so the client can render
 * it in a plain <pre> without a terminal emulator.
 *
 * 410 Gone when the tmux session no longer exists (agent crashed, exited
 * cleanly, or was killed between polls). Before returning 410 we also ask
 * the supervisor to reap the agent, which transitions it to `exited` and
 * removes it from the dashboard's live list — so the user's next page
 * invalidate moves the card straight into the archive.
 */

import { error, json } from '@sveltejs/kit';
import stripAnsi from 'strip-ansi';
import type { RequestHandler } from './$types';
import { getAgent } from '$lib/server/db/queries';
import { Tmux } from '$lib/server/tmux/TmuxSession';
import { getSupervisor } from '$lib/server/bootstrap';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  const alive = await Tmux.hasSession(agent.tmux_session);
  if (!alive) {
    // Fire-and-catch: if the runtime is still in the supervisor map, tear
    // it down now so the next /dashboard poll sees the archived row.
    try {
      await getSupervisor().reapAgent(agent.id);
    } catch (err) {
      console.error(`[snapshot] reapAgent failed for ${agent.id}:`, err);
    }
    return json({ text: '', ts: Math.floor(Date.now() / 1000), alive: false }, { status: 410 });
  }

  // Capture the entire visible pane (0 = top of current screen → bottom),
  // not just the last 50 lines of scrollback, so the thumbnail shows what
  // the user would see if they opened the terminal right now.
  const raw = await Tmux.capturePane(agent.tmux_session, 0);
  return json({
    text: stripAnsi(raw),
    ts: Math.floor(Date.now() / 1000),
    alive: true
  });
};
