/**
 * GET /api/agents/:id/snapshot
 *
 * Returns a text snapshot of the agent's tmux pane for the dashboard
 * thumbnail card, with SGR escape sequences preserved so the client
 * can parse them into colored <span>s (see `$lib/client/ansi.ts`).
 *
 * 410 Gone when the tmux session no longer exists (agent crashed, exited
 * cleanly, or was killed between polls). Before returning 410 we also ask
 * the supervisor to reap the agent, which transitions it to `exited` and
 * removes it from the dashboard's live list — so the user's next page
 * invalidate moves the card straight into the archive.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent } from '$lib/server/db/queries';
import { Tmux } from '$lib/server/tmux/TmuxSession';
import { getSupervisor } from '$lib/server/bootstrap';
import { isBrowserKind } from '$lib/server/agents/AgentSupervisor';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  // Browser agents never have a tmux pane; AgentCard skips polling for them
  // anyway, but guard here too so any stragglers (cached HTML, hand-crafted
  // requests) don't get a 410 that the dashboard would interpret as crashed.
  if (isBrowserKind(agent.cli_kind)) {
    return json({ text: '', ts: Math.floor(Date.now() / 1000), alive: true });
  }

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
  // the user would see if they opened the terminal right now. capturePane
  // passes tmux `-e`, so SGR escapes are included — the client parses
  // them into colored <span>s for the thumbnail render.
  const raw = await Tmux.capturePane(agent.tmux_session, 0);
  return json({
    text: raw,
    ts: Math.floor(Date.now() / 1000),
    alive: true
  });
};
