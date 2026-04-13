import { error } from '@sveltejs/kit';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { deletePushSubByEndpoint } from '$lib/server/db/queries';

const schema = z.object({
  endpoint: z.string().url()
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

  deletePushSubByEndpoint(parsed.data.endpoint);

  return new Response(null, { status: 204 });
};
