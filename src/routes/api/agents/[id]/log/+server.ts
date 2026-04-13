/**
 * GET /api/agents/:id/log
 *
 * Returns the agent's full persisted terminal_log as a single
 * application/octet-stream response. Used by the archived-agent log viewer
 * modal — no WebSocket, no live updates, just a one-shot replay.
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent, listAllTerminalChunks } from '$lib/server/db/queries';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  const rows = listAllTerminalChunks(agent.id);
  const total = rows.reduce((n, r) => n + r.chunk.length, 0);
  const buf = Buffer.alloc(total);
  let off = 0;
  for (const r of rows) {
    r.chunk.copy(buf, off);
    off += r.chunk.length;
  }
  return new Response(buf, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store'
    }
  });
};
