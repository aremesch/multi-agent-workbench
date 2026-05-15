import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listRoles } from '$lib/server/db/queries';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return {
    roles: listRoles(locals.user.id),
    // Surface the full adapter listing — the role-edit dialog needs
    // capability metadata (model + permissionMode values) to render the
    // adapter-specific dropdowns.
    cliKinds: locals.supervisor.registry.list()
  };
};
