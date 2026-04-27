import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth, forwardCookiesFromResponse } from '$lib/server/auth/betterAuth';
import { setMustChangePassword } from '$lib/server/db/queries';
import { logAuth } from '$lib/server/auth/authLog';
import { clientIp } from '$lib/server/net/clientIp';
import { t } from '$lib/i18n';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return { username: locals.user.username };
};

export const actions: Actions = {
  changePassword: async (event) => {
    const { request, locals } = event;
    if (!locals.user) {
      return fail(401, { error: t(locals.locale, 'account.error.notSignedIn') });
    }
    const ip = clientIp(event);
    const ua = request.headers.get('user-agent');
    const username = locals.user.username;
    const userId = locals.user.id;
    const form = await request.formData();
    const current = String(form.get('current') ?? '');
    const next = String(form.get('next') ?? '');
    const confirm = String(form.get('confirm') ?? '');

    if (!current || !next || !confirm) {
      return fail(400, { error: t(locals.locale, 'account.error.allRequired') });
    }
    if (next.length < 8) {
      return fail(400, { error: t(locals.locale, 'account.error.minLength') });
    }
    if (next !== confirm) {
      return fail(400, { error: t(locals.locale, 'account.error.mismatch') });
    }
    if (next === current) {
      return fail(400, { error: t(locals.locale, 'account.error.samePw') });
    }

    // asResponse:true so we can forward Set-Cookie headers (better-auth
    // refreshes the session on a successful password change). With
    // asResponse, errors come back as non-OK responses (NOT thrown
    // APIErrors) — check resp.ok and inspect the body's `code` field.
    // See betterAuth.ts header comment for why we don't use the
    // sveltekitCookies plugin.
    const resp = await auth.api.changePassword({
      body: { currentPassword: current, newPassword: next, revokeOtherSessions: true },
      headers: request.headers,
      asResponse: true
    });
    forwardCookiesFromResponse(resp, event.cookies);

    if (!resp.ok) {
      const body = (await resp
        .json()
        .catch(() => null)) as { code?: string; message?: string } | null;
      // INVALID_PASSWORD is better-auth's wrong-current-password code.
      // PASSWORD_TOO_SHORT/_LONG are already validated by the form above —
      // they only land here on direct API hits and stay generic 400s.
      if (body?.code === 'INVALID_PASSWORD') {
        logAuth('pwchange_fail', {
          userId,
          username,
          ip,
          userAgent: ua,
          detail: 'wrong-current'
        });
        return fail(401, { error: t(locals.locale, 'account.error.wrongCurrent') });
      }
      return fail(400, { error: t(locals.locale, 'account.error.allRequired') });
    }

    setMustChangePassword(userId, false);
    logAuth('pwchange_ok', { userId, username, ip, userAgent: ua });

    return { success: true };
  }
};
