import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { t } from '$lib/i18n';
import {
  DEFAULT_SUPERVISOR_SETTINGS,
  getSupervisorSettings,
  setSupervisorSettings,
  type SupervisorSettings
} from '$lib/server/db/queries';

/** GET /api/supervisor/settings — the caller's supervisor settings. */
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  return json({ settings: getSupervisorSettings(locals.user.id) });
};

/** PUT /api/supervisor/settings — replace the caller's supervisor settings. */
export const PUT: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }
  let body: Partial<SupervisorSettings>;
  try {
    body = (await request.json()) as Partial<SupervisorSettings>;
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }
  // Merge over current then re-read through the validating getter.
  const current = getSupervisorSettings(locals.user.id);
  const merged: SupervisorSettings = { ...DEFAULT_SUPERVISOR_SETTINGS, ...current, ...body };
  setSupervisorSettings(locals.user.id, merged);
  return json({ settings: getSupervisorSettings(locals.user.id) });
};
