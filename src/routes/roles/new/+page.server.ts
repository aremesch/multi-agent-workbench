import { fail, redirect } from '@sveltejs/kit';
import { ulid } from 'ulid';
import type { Actions, PageServerLoad } from './$types';
import { insertRole } from '$lib/server/db/queries';
import { t } from '$lib/i18n';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  return {
    cliKinds: locals.supervisor.registry.list()
  };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    if (!locals.user) throw redirect(303, '/login');
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim();
    const cli_kind = String(form.get('cli_kind') ?? '').trim();
    const system_prompt = String(form.get('system_prompt') ?? '');

    const fields = { name, cli_kind, system_prompt };
    const kinds = new Set(locals.supervisor.registry.list().map((k) => k.kind));

    if (!name) {
      return fail(400, { ...fields, error: t(locals.locale, 'common.error.nameRequired') });
    }
    if (!kinds.has(cli_kind)) {
      return fail(400, { ...fields, error: t(locals.locale, 'spawn.error.unknownCliKind') });
    }

    const id = ulid();
    insertRole({
      id,
      user_id: locals.user.id,
      name,
      system_prompt,
      cli_kind,
      default_args_json: '{}',
      tool_config_json: '{}',
      repo_scope_json: '{}'
    });
    throw redirect(303, '/roles');
  }
};
