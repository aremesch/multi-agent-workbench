import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
  getQueueConcurrency,
  getSpawnDefaultsAll,
  listQueueEntriesForUser,
  listReposWithProjectForUser,
  listRoles
} from '$lib/server/db/queries';

/**
 * Server load for the global queue page.
 *
 * Returns every entry the user has so the client can group + filter without
 * a second round-trip. Also ships the data the spawn form needs (roles,
 * repos, cliKinds, spawn defaults) plus the current concurrency settings.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  const cliKinds = locals.supervisor.registry.list();
  const repos = listReposWithProjectForUser(locals.user.id).map((r) => ({
    id: r.id,
    path: r.path,
    projectName: r.project_name
  }));
  return {
    entries: listQueueEntriesForUser(locals.user.id),
    concurrency: getQueueConcurrency(locals.user.id),
    roles: listRoles(locals.user.id),
    repos,
    cliKinds,
    spawnDefaults: getSpawnDefaultsAll(
      locals.user.id,
      cliKinds.map((k) => k.kind)
    )
  };
};
