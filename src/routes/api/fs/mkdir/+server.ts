import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyCsrf } from '$lib/server/auth/csrf';
import { getFsBrowseRoot } from '$lib/server/config';
import { BrowseError, createDirectory } from '$lib/server/fs/browse';
import { t } from '$lib/i18n';

/**
 * POST /api/fs/mkdir
 * Body: { parent: string, name: string }
 *
 * Creates a sub-directory under `parent`, clamped to the server-side
 * sandbox root. Auth + CSRF required. Returns the realpath of the new
 * directory on success.
 */
export const POST: RequestHandler = async ({ locals, request, cookies }) => {
  verifyCsrf({ cookies, request });
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const parent = String(b.parent ?? '').trim();
  const name = String(b.name ?? '').trim();

  if (!parent) {
    return json({ error: t(locals.locale, 'common.error.pathRequired') }, { status: 400 });
  }

  const root = getFsBrowseRoot();
  try {
    const path = createDirectory(parent, name, root);
    return json({ path });
  } catch (err) {
    if (err instanceof BrowseError) {
      switch (err.code) {
        case 'outside_root':
          return json(
            { error: t(locals.locale, 'picker.error.outsideRoot') },
            { status: 403 }
          );
        case 'not_found':
          return json(
            { error: t(locals.locale, 'common.error.pathNotExist') },
            { status: 404 }
          );
        case 'not_directory':
          return json(
            { error: t(locals.locale, 'common.error.pathNotDir') },
            { status: 400 }
          );
        case 'invalid_name':
          return json(
            { error: t(locals.locale, 'picker.error.mkdirInvalidName') },
            { status: 400 }
          );
        case 'already_exists':
          return json(
            { error: t(locals.locale, 'picker.error.mkdirExists') },
            { status: 409 }
          );
        case 'mkdir_failed':
        case 'read_failed':
          return json(
            { error: t(locals.locale, 'picker.error.mkdirFailed', { message: err.message }) },
            { status: 500 }
          );
      }
    }
    return json(
      { error: t(locals.locale, 'picker.error.mkdirFailed', { message: (err as Error).message }) },
      { status: 500 }
    );
  }
};
