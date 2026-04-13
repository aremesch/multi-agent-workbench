import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getSpawnDefaultsAll, getUserSetting } from '$lib/server/db/queries';
import { getConfig } from '$lib/server/config';
import { PUSH_PREFS_KEY, parseNotifyKinds } from '$lib/server/push/pushPrefs';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  const cliKinds = locals.supervisor.registry.list();
  const spawnDefaults = getSpawnDefaultsAll(
    locals.user.id,
    cliKinds.map((k) => k.kind)
  );
  const pushNotifyKinds = parseNotifyKinds(getUserSetting(locals.user.id, PUSH_PREFS_KEY));
  const vapidConfigured = !!getConfig().vapidPublicKey;
  return { cliKinds, spawnDefaults, pushNotifyKinds, vapidConfigured };
};
