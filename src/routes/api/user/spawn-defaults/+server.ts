import { error } from '@sveltejs/kit';
import { verifyCsrf } from '$lib/server/auth/csrf';
import type { RequestHandler } from './$types';
import { setUserSetting } from '$lib/server/db/queries';
import { sanitizeCapabilityValue } from '$lib/server/agents/adapters/capabilityValidation';

interface PutBody {
  cliKind?: string;
  optionalArgs?: Record<string, boolean>;
  /** Capability-value id (e.g. `opus`). `null` clears the per-user default. */
  defaultModel?: string | null;
  /** Capability-value id (e.g. `plan`). `null` clears the per-user default. */
  defaultPermissionMode?: string | null;
}

export const PUT: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const {
    cliKind,
    optionalArgs,
    defaultModel,
    defaultPermissionMode
  } = body as PutBody;
  if (!cliKind || typeof cliKind !== 'string') throw error(400, 'Missing cliKind');
  if (!optionalArgs || typeof optionalArgs !== 'object') throw error(400, 'Missing optionalArgs');

  // Validate all values are booleans.
  for (const v of Object.values(optionalArgs)) {
    if (typeof v !== 'boolean') throw error(400, 'optionalArgs values must be booleans');
  }

  // Validate capability-value ids against the loaded adapter so a stale
  // dropdown value can't poison the spawn form. Resolving the adapter
  // here also confirms cliKind is one the server actually serves.
  const adapter = locals.supervisor.registry
    .list()
    .find((k) => k.kind === cliKind);
  if (!adapter) throw error(400, `unknown cliKind: ${cliKind}`);

  const sanitizedModel =
    defaultModel === null || defaultModel === undefined
      ? null
      : sanitizeCapabilityValue(adapter.capabilities.model, defaultModel);
  if (defaultModel && !sanitizedModel) {
    throw error(400, `invalid defaultModel: ${defaultModel}`);
  }

  const sanitizedPermissionMode =
    defaultPermissionMode === null || defaultPermissionMode === undefined
      ? null
      : sanitizeCapabilityValue(adapter.capabilities.permissionMode, defaultPermissionMode);
  if (defaultPermissionMode && !sanitizedPermissionMode) {
    throw error(400, `invalid defaultPermissionMode: ${defaultPermissionMode}`);
  }

  setUserSetting(
    locals.user.id,
    `spawn.defaults.${cliKind}`,
    JSON.stringify({
      optionalArgs,
      defaultModel: sanitizedModel,
      defaultPermissionMode: sanitizedPermissionMode
    })
  );
  return new Response(null, { status: 204 });
};
