import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listAgentsForUser, listProjects } from '$lib/server/db/queries';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return {
    projects: listProjects(locals.user.id),
    agents: listAgentsForUser(locals.user.id)
  };
};
