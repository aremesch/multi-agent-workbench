import { error } from '@sveltejs/kit';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { setUserSetting } from '$lib/server/db/queries';
import { MOBILE_QUICK_KEYS_SETTING_KEY } from '$lib/shared/dashboard';

const schema = z.object({ mode: z.enum(['auto', 'always', 'never']) });

export const PUT: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw error(400, 'Invalid body');
  setUserSetting(
    locals.user.id,
    MOBILE_QUICK_KEYS_SETTING_KEY,
    JSON.stringify(parsed.data.mode)
  );
  return new Response(null, { status: 204 });
};
