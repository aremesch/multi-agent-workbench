import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getUserByUsername, deleteSession } from '$lib/server/db/queries';
import { verifyPassword } from '$lib/server/auth/password';
import {
  clearSessionCookie,
  createSession,
  setSessionCookie,
  SESSION_COOKIE
} from '$lib/server/auth/session';
import { logAuth } from '$lib/server/auth/authLog';
import { checkRate } from '$lib/server/auth/rateLimit';
import { clientIp } from '$lib/server/net/clientIp';
import { getConfig } from '$lib/server/config';
import { t } from '$lib/i18n';

export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user) throw redirect(303, '/');
  return {};
};

export const actions: Actions = {
  login: async (event) => {
    const { request, cookies, locals } = event;
    const ip = clientIp(event);
    const ua = request.headers.get('user-agent');
    const form = await request.formData();
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');

    const rl = getConfig().loginRateLimit;
    if (!checkRate('login:' + ip, rl.count, rl.windowSeconds)) {
      logAuth('rate_limited', { username, ip, userAgent: ua });
      return fail(429, {
        username,
        error: t(locals.locale, 'login.error.rateLimited')
      });
    }

    if (!username || !password) {
      return fail(400, { username, error: t(locals.locale, 'login.error.required') });
    }
    const user = getUserByUsername(username);
    if (!user) {
      logAuth('login_fail', { username, ip, userAgent: ua, detail: 'no-user' });
      return fail(401, { username, error: t(locals.locale, 'login.error.invalid') });
    }
    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      logAuth('login_fail', {
        userId: user.id,
        username,
        ip,
        userAgent: ua,
        detail: 'bad-password'
      });
      return fail(401, { username, error: t(locals.locale, 'login.error.invalid') });
    }

    const session = createSession(user.id, ua);
    setSessionCookie(cookies, session.id);
    logAuth('login_ok', { userId: user.id, username, ip, userAgent: ua });

    if (user.must_change_password) throw redirect(303, '/account');
    throw redirect(303, '/');
  },

  logout: async (event) => {
    const { cookies } = event;
    const sid = cookies.get(SESSION_COOKIE);
    if (sid) {
      const ip = clientIp(event);
      const ua = event.request.headers.get('user-agent');
      const userId = event.locals.user?.id ?? null;
      const username = event.locals.user?.username ?? null;
      deleteSession(sid);
      logAuth('session_revoked', { userId, username, ip, userAgent: ua });
    }
    clearSessionCookie(cookies);
    throw redirect(303, '/login');
  }
};

