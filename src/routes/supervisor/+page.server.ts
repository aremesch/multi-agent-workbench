import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
  getSupervisorSettings,
  listReposForUser,
  listRoles,
  listSupervisorRunsForUser
} from '$lib/server/db/queries';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return {
    runs: listSupervisorRunsForUser(locals.user.id),
    repos: listReposForUser(locals.user.id),
    roles: listRoles(locals.user.id),
    settings: getSupervisorSettings(locals.user.id)
  };
};
