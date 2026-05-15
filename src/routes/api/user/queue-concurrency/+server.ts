import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { verifyCsrf } from '$lib/server/auth/csrf';
import type { RequestHandler } from './$types';
import {
  getQueueConcurrency,
  setQueueConcurrency
} from '$lib/server/db/queries';
import { getScheduler } from '$lib/server/bootstrap';

const schema = z.object({
  maxConcurrentGlobal: z.number().int().min(0).max(1000),
  maxConcurrentPerRepo: z.number().int().min(0).max(1000),
  perRepoOverrides: z
    .record(z.string(), z.number().int().min(0).max(1000))
    .optional()
});

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  return new Response(JSON.stringify(getQueueConcurrency(locals.user.id)), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};

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
  setQueueConcurrency(locals.user.id, {
    maxConcurrentGlobal: parsed.data.maxConcurrentGlobal,
    maxConcurrentPerRepo: parsed.data.maxConcurrentPerRepo,
    perRepoOverrides: parsed.data.perRepoOverrides ?? {}
  });
  // New caps may unblock previously waiting entries.
  getScheduler().scheduleTick();
  return new Response(null, { status: 204 });
};
