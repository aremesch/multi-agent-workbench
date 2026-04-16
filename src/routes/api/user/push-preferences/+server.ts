import { error } from '@sveltejs/kit';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { setUserSetting } from '$lib/server/db/queries';
import { ALL_NOTIFY_KINDS, PUSH_PREFS_KEY } from '$lib/server/push/pushPrefs';

const schema = z.object({
  kinds: z.array(z.enum(['prompt_detected', 'task_done', 'error', 'exited']))
});

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

  setUserSetting(locals.user.id, PUSH_PREFS_KEY, JSON.stringify(parsed.data.kinds));

  return new Response(null, { status: 204 });
};
