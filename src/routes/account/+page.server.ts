import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hashPassword, verifyPassword } from '$lib/server/auth/password';
import {
  deleteSessionsForUserExcept,
  updateUserPasswordHash
} from '$lib/server/db/queries';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return { username: locals.user.username };
};

export const actions: Actions = {
  changePassword: async ({ request, locals }) => {
    if (!locals.user || !locals.session) {
      return fail(401, { error: 'Not signed in' });
    }
    const form = await request.formData();
    const current = String(form.get('current') ?? '');
    const next = String(form.get('next') ?? '');
    const confirm = String(form.get('confirm') ?? '');

    if (!current || !next || !confirm) {
      return fail(400, { error: 'All fields are required' });
    }
    if (next.length < 8) {
      return fail(400, { error: 'New password must be at least 8 characters' });
    }
    if (next !== confirm) {
      return fail(400, { error: 'New passwords do not match' });
    }
    if (next === current) {
      return fail(400, { error: 'New password must differ from current password' });
    }

    const ok = await verifyPassword(locals.user.password_hash, current);
    if (!ok) {
      return fail(401, { error: 'Current password incorrect' });
    }

    const hash = await hashPassword(next);
    updateUserPasswordHash(locals.user.id, hash);
    deleteSessionsForUserExcept(locals.user.id, locals.session.id);

    return { success: true };
  }
};
