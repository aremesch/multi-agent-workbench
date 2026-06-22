import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getSupervisorRunForUser } from '$lib/server/db/queries';

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(303, '/login');
  const run = getSupervisorRunForUser(params.id, locals.user.id);
  if (!run) throw error(404, 'Run not found');
  return { runId: run.id };
};
