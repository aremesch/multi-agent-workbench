import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setUserSetting } from '$lib/server/db/queries';

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const { cliKind, optionalArgs } = body as {
    cliKind?: string;
    optionalArgs?: Record<string, boolean>;
  };
  if (!cliKind || typeof cliKind !== 'string') throw error(400, 'Missing cliKind');
  if (!optionalArgs || typeof optionalArgs !== 'object') throw error(400, 'Missing optionalArgs');

  // Validate all values are booleans.
  for (const v of Object.values(optionalArgs)) {
    if (typeof v !== 'boolean') throw error(400, 'optionalArgs values must be booleans');
  }

  setUserSetting(
    locals.user.id,
    `spawn.defaults.${cliKind}`,
    JSON.stringify({ optionalArgs })
  );
  return new Response(null, { status: 204 });
};
