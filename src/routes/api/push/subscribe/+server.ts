import { error } from '@sveltejs/kit';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { upsertPushSub } from '$lib/server/db/queries';

const schema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  })
});

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
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

  upsertPushSub({
    id: ulid(),
    user_id: locals.user.id,
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
    ua: request.headers.get('user-agent')
  });

  return new Response(null, { status: 201 });
};
