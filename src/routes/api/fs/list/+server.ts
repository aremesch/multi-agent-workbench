import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getFsBrowseRoot } from '$lib/server/config';
import { BrowseError, listDirectory } from '$lib/server/fs/browse';
import { t } from '$lib/i18n';

/**
 * GET /api/fs/list?path=<abs>&hidden=<0|1>
 *
 * Returns a sorted list of immediate sub-directories of `path`,
 * clamped to the server-side sandbox root (`getFsBrowseRoot()`,
 * defaults to `$HOME`). Auth-gated; no CSRF (read-only).
 *
 * Response shape:
 *   { path, parent, entries: [{name, isGitRepo}] }
 *
 * Errors: 401 unauthorized, 403 outside root, 404 not found,
 * 400 not a directory.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) {
    return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });
  }

  const root = getFsBrowseRoot();
  const requested = url.searchParams.get('path');
  const showHidden = url.searchParams.get('hidden') === '1';

  try {
    const result = listDirectory(requested, root, { showHidden });
    return json({ root, ...result });
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
        case 'read_failed':
          return json(
            { error: t(locals.locale, 'picker.error.load') },
            { status: 400 }
          );
      }
    }
    return json(
      { error: t(locals.locale, 'picker.error.load') },
      { status: 500 }
    );
  }
};
