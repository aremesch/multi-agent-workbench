import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hashPassword, verifyPassword } from '$lib/server/auth/password';
import {
  deleteSessionsForUserExcept,
  updateUserPasswordHash
} from '$lib/server/db/queries';
import { t } from '$lib/i18n';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return { username: locals.user.username };
};

export const actions: Actions = {
  changePassword: async ({ request, locals }) => {
    if (!locals.user || !locals.session) {
      return fail(401, { error: t(locals.locale, 'account.error.notSignedIn') });
    }
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

    const ok = await verifyPassword(locals.user.password_hash, current);
    if (!ok) {
      return fail(401, { error: t(locals.locale, 'account.error.wrongCurrent') });
    }

    const hash = await hashPassword(next);
    updateUserPasswordHash(locals.user.id, hash);
    deleteSessionsForUserExcept(locals.user.id, locals.session.id);

    return { success: true };
  }
};
