import { fail, redirect } from '@sveltejs/kit';
import { ulid } from 'ulid';
import type { Actions, PageServerLoad } from './$types';
import { insertProject } from '$lib/server/db/queries';
import { t } from '$lib/i18n';

const BRANCH_RE = /^[\w./-]+$/;

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return {};
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    if (!locals.user) throw redirect(303, '/login');
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim();
    const default_branch = String(form.get('default_branch') ?? '').trim() || 'main';

    if (!name) {
      return fail(400, { name, default_branch, error: t(locals.locale, 'common.error.nameRequired') });
    }
    if (!BRANCH_RE.test(default_branch)) {
      return fail(400, {
        name,
        default_branch,
        error: t(locals.locale, 'common.error.invalidBranch')
      });
    }

    const id = ulid();
    insertProject({ id, user_id: locals.user.id, name, default_branch });
    throw redirect(303, `/projects/${id}`);
  }
};
