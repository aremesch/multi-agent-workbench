import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth, forwardCookiesFromResponse } from '$lib/server/auth/betterAuth';
import { logAuth } from '$lib/server/auth/authLog';
import { checkRate } from '$lib/server/auth/rateLimit';
import { clientIp } from '$lib/server/net/clientIp';
import { getMustChangePasswordById } from '$lib/server/db/queries';
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
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');

    if (!email || !password) {
      return fail(400, { email, error: t(locals.locale, 'login.error.required') });
    }

    // Per-IP rate limit. Better-auth's built-in limiter only protects its
    // own HTTP routes (/api/auth/*); this form action calls `auth.api.*`
    // directly, bypassing it. Keep a small in-memory bucket so fail2ban
    // gets steady `rate_limited` lines on password sprays.
    const rl = getConfig().loginRateLimit;
    if (!checkRate('login:' + ip, rl.count, rl.windowSeconds)) {
      logAuth('rate_limited', { username: email, ip, userAgent: ua });
      return fail(429, { email, error: t(locals.locale, 'login.error.rateLimited') });
    }

    // asResponse:true gives us a Response with the Set-Cookie headers we
    // need to forward to SvelteKit's event.cookies — the sveltekitCookies
    // plugin would do this automatically but we don't run it (see
    // betterAuth.ts header comment). With asResponse, errors come back as
    // non-OK responses (NOT thrown APIErrors); check resp.ok explicitly.
    const resp = await auth.api.signInEmail({
      body: { email, password },
      headers: request.headers,
      asResponse: true
    });
    forwardCookiesFromResponse(resp, cookies);

    if (!resp.ok) {
      const body = (await resp
        .json()
        .catch(() => null)) as { code?: string; message?: string } | null;
      const detail = body?.code ?? `status-${resp.status}`;
      if (resp.status === 429) {
        logAuth('rate_limited', { username: email, ip, userAgent: ua });
        return fail(429, { email, error: t(locals.locale, 'login.error.rateLimited') });
      }
      // Covers UNAUTHORIZED + INVALID_EMAIL_OR_PASSWORD, BAD_REQUEST +
      // INVALID_EMAIL, FORBIDDEN + EMAIL_NOT_VERIFIED. Map all to a single
      // generic "invalid credentials" error to avoid disclosing which
      // field is wrong (matches the prior /login behaviour).
      logAuth('login_fail', { username: email, ip, userAgent: ua, detail });
      return fail(401, { email, error: t(locals.locale, 'login.error.invalid') });
    }

    const data = (await resp.json()) as { user?: { id: string } };
    const userId = data.user?.id;
    if (!userId) {
      // Defensive: 200 OK with no user is unexpected. Treat as a sign-in
      // failure so we never silently redirect into a logged-out state.
      logAuth('login_fail', {
        username: email,
        ip,
        userAgent: ua,
        detail: 'no-user-in-200-response'
      });
      return fail(401, { email, error: t(locals.locale, 'login.error.invalid') });
    }
    logAuth('login_ok', { userId, username: email, ip, userAgent: ua });
    if (getMustChangePasswordById(userId)) throw redirect(303, '/account');
    throw redirect(303, '/');
  },

  logout: async (event) => {
    const { cookies } = event;
    const ip = clientIp(event);
    const ua = event.request.headers.get('user-agent');
    const userId = event.locals.user?.id ?? null;
    const username = event.locals.user?.username ?? null;
    try {
      const resp = await auth.api.signOut({
        headers: event.request.headers,
        asResponse: true
      });
      forwardCookiesFromResponse(resp, cookies);
    } catch {
      // signOut errors when there's no active session; treat as a no-op
      // for the user-facing logout flow — we still want them sent to
      // /login.
    }
    if (userId) logAuth('session_revoked', { userId, username, ip, userAgent: ua });
    throw redirect(303, '/login');
  }
};
