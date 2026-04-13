import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getUserByUsername } from '$lib/server/db/queries';
import { verifyPassword } from '$lib/server/auth/password';
import {
  clearSessionCookie,
  createSession,
  setSessionCookie,
  SESSION_COOKIE
} from '$lib/server/auth/session';
import { deleteSession } from '$lib/server/db/queries';
import { t } from '$lib/i18n';

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user) throw redirect(303, '/');
  return {};
};

export const actions: Actions = {
  login: async ({ request, cookies, locals }) => {
    const form = await request.formData();
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');
    if (!username || !password) {
      return fail(400, { username, error: t(locals.locale, 'login.error.required') });
    }
    const user = getUserByUsername(username);
    if (!user) {
      return fail(401, { username, error: t(locals.locale, 'login.error.invalid') });
    }
    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      return fail(401, { username, error: t(locals.locale, 'login.error.invalid') });
    }
    const ua = request.headers.get('user-agent');
    const session = createSession(user.id, ua);
    setSessionCookie(cookies, session.id);
    throw redirect(303, '/');
  },

  logout: async ({ cookies }) => {
    const sid = cookies.get(SESSION_COOKIE);
    if (sid) deleteSession(sid);
    clearSessionCookie(cookies);
    throw redirect(303, '/login');
  }
};
