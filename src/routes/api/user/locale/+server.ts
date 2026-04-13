import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setUserSetting } from '$lib/server/db/queries';
import { LOCALE_SETTING_KEY, SUPPORTED_LOCALES, type Locale } from '$lib/i18n';

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const locale = (body as { locale?: unknown })?.locale;
  if (typeof locale !== 'string' || !SUPPORTED_LOCALES.includes(locale as Locale)) {
    throw error(400, 'Invalid locale');
  }
  setUserSetting(locals.user.id, LOCALE_SETTING_KEY, JSON.stringify(locale));
  return new Response(null, { status: 204 });
};
