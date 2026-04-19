import { error } from '@sveltejs/kit';
import { verifyCsrf } from '$lib/server/auth/csrf';
import type { RequestHandler } from './$types';
import { setUserSetting } from '$lib/server/db/queries';
import { THEME_SETTING_KEY, isThemeId } from '$lib/shared/dashboard';

export const PUT: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const theme = (body as { theme?: unknown })?.theme;
  if (!isThemeId(theme)) throw error(400, 'Invalid theme');
  setUserSetting(locals.user.id, THEME_SETTING_KEY, JSON.stringify(theme));
  return new Response(null, { status: 204 });
};
