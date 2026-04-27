/**
 * PUT /api/agents/:id/target
 *
 * Update the target URL of a live browser agent. Used by the BrowserView
 * toolbar so the user can hop between dev-server ports (e.g. 5173 → 5174
 * when a second `pnpm dev` claims the next port) without re-spawning.
 *
 * Body: `{ target_url: string }`. The URL is validated against the same
 * `parseBrowserTargetUrl` helper the spawn form uses, so the rules stay
 * in lock-step (http://, localhost or 127.0.0.1, port 1..65535).
 *
 * Responds 409 when the agent is archived (changing the target on an
 * exited agent makes no sense — the iframe isn't visible there) or
 * isn't the browser kind.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent, updateAgentTarget } from '$lib/server/db/queries';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { isBrowserKind } from '$lib/server/agents/AgentSupervisor';
import { parseBrowserTargetUrl } from '$lib/shared/browserTarget';

const ARCHIVED_STATUSES = new Set(['exited', 'crashed']);

export const PUT: RequestHandler = async ({ locals, params, cookies, request }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  if (!isBrowserKind(agent.cli_kind)) {
    return json({ code: 'not_browser_agent' }, { status: 409 });
  }
  if (ARCHIVED_STATUSES.has(agent.status)) {
    return json({ code: 'archived', status: agent.status }, { status: 409 });
  }

  const body = (await request.json().catch(() => ({}))) as { target_url?: unknown };
  const raw = typeof body.target_url === 'string' ? body.target_url : '';
  const parsed = parseBrowserTargetUrl(raw);
  if (!parsed.ok) {
    return json({ code: `invalid_url_${parsed.error}` }, { status: 400 });
  }

  const changed = updateAgentTarget(agent.id, locals.user.id, parsed.url, parsed.port);
  if (changed === 0) {
    // Either the row vanished mid-request or the user_id check tripped.
    // 404 keeps callers from inferring agent existence under another owner.
    throw error(404, 'Agent not found');
  }

  return json({ target_url: parsed.url, target_port: parsed.port });
};
