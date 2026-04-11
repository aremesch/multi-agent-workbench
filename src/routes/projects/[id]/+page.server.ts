import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getProject, listReposForProject } from '$lib/server/db/queries';

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(303, '/login');
  const project = getProject(params.id);
  if (!project) throw error(404, 'Project not found');
  if (project.user_id !== locals.user.id) throw error(403, 'Forbidden');
  return {
    project,
    repos: listReposForProject(project.id)
  };
};
