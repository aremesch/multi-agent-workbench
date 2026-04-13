import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getSpawnDefaultsAll } from '$lib/server/db/queries';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  const cliKinds = locals.supervisor.registry.list();
  const spawnDefaults = getSpawnDefaultsAll(
    locals.user.id,
    cliKinds.map((k) => k.kind)
  );
  return { cliKinds, spawnDefaults };
};
