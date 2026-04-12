import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { setUserSetting } from '$lib/server/db/queries';
import { SIDEBAR_COLLAPSED_KEY } from '$lib/shared/dashboard';

const schema = z.object({ collapsed: z.boolean() });

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw error(400, 'Invalid body');
  setUserSetting(locals.user.id, SIDEBAR_COLLAPSED_KEY, JSON.stringify(parsed.data));
  return new Response(null, { status: 204 });
};
