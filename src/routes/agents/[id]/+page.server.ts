import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getAgent } from '$lib/server/db/queries';

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(303, '/login');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');
  return {
    agent: {
      id: agent.id,
      cli_kind: agent.cli_kind,
      status: agent.status,
      tmux_session: agent.tmux_session,
      target_url: agent.target_url
    }
  };
};
