import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listRoles } from '$lib/server/db/queries';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return {
    roles: listRoles(locals.user.id)
  };
};
