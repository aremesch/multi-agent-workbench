import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSpawnDefaultsAll, getUserSetting } from '$lib/server/db/queries';
import { getConfig } from '$lib/server/config';
import { PUSH_PREFS_KEY, parseNotifyKinds } from '$lib/server/push/pushPrefs';
import {
  getStoredGitIdentity,
  setGitIdentity,
  validateGitIdentity
} from '$lib/server/user/gitIdentity';
import { t } from '$lib/i18n';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  const cliKinds = locals.supervisor.registry.list();
  const spawnDefaults = getSpawnDefaultsAll(
    locals.user.id,
    cliKinds.map((k) => k.kind)
  );
  const pushNotifyKinds = parseNotifyKinds(getUserSetting(locals.user.id, PUSH_PREFS_KEY));
  const vapidConfigured = !!getConfig().vapidPublicKey;
  const gitIdentity = getStoredGitIdentity(locals.user.id);
  return { cliKinds, spawnDefaults, pushNotifyKinds, vapidConfigured, gitIdentity };
};

export const actions: Actions = {
  gitIdentity: async ({ request, locals }) => {
    if (!locals.user) {
      return fail(401, {
        gitAuthorName: '',
        gitAuthorEmail: '',
        error: t(locals.locale, 'account.error.notSignedIn'),
        gitIdentitySaved: false
      });
    }
    const form = await request.formData();
    const name = String(form.get('gitAuthorName') ?? '').trim();
    const email = String(form.get('gitAuthorEmail') ?? '').trim();

    const err = validateGitIdentity(name, email);
    if (err) {
      return fail(400, {
        gitAuthorName: name,
        gitAuthorEmail: email,
        error: t(locals.locale, `settings.git.error.${err}`),
        gitIdentitySaved: false
      });
    }

    setGitIdentity(locals.user.id, { name, email });
    return {
      gitAuthorName: name,
      gitAuthorEmail: email,
      gitIdentitySaved: true,
      error: null
    };
  }
};
