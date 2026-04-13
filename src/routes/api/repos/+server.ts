import { json } from '@sveltejs/kit';
import { isAbsolute } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { execa } from 'execa';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { getProject, insertRepo } from '$lib/server/db/queries';
import { WorktreeManager } from '$lib/server/git/WorktreeManager';
import { t } from '$lib/i18n';

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return json({ error: t(locals.locale, 'common.error.unauthorized') }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: t(locals.locale, 'common.error.invalidJson') }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const project_id = String(b.project_id ?? '').trim();
  const path = String(b.path ?? '').trim();
  const origin_url = String(b.origin_url ?? '').trim() || null;

  const project = getProject(project_id);
  if (!project) return json({ error: t(locals.locale, 'common.error.projectNotFound') }, { status: 400 });
  if (project.user_id !== locals.user.id) return json({ error: t(locals.locale, 'common.error.forbidden') }, { status: 403 });

  if (!path) return json({ error: t(locals.locale, 'common.error.pathRequired') }, { status: 400 });
  if (!isAbsolute(path)) return json({ error: t(locals.locale, 'common.error.pathNotAbsolute') }, { status: 400 });
  if (!existsSync(path)) return json({ error: t(locals.locale, 'common.error.pathNotExist') }, { status: 400 });
  if (!statSync(path).isDirectory()) return json({ error: t(locals.locale, 'common.error.pathNotDir') }, { status: 400 });

  const entries = readdirSync(path);
  if (entries.length === 0) {
    try {
      await WorktreeManager.initEmpty(path, project.default_branch);
    } catch (err) {
      return json(
        { error: t(locals.locale, 'common.error.gitInitFailed', { message: (err as Error).message }) },
        { status: 400 }
      );
    }
  } else {
    try {
      await execa('git', ['-C', path, 'rev-parse', '--git-dir']);
    } catch {
      return json(
        { error: t(locals.locale, 'common.error.notGitNotEmpty') },
        { status: 400 }
      );
    }

    const normalized = await WorktreeManager.ensureDefaultBranch(path, project.default_branch);
    if (normalized.kind === 'no_master') {
      const where = normalized.current ? ` (currently on '${normalized.current}')` : '';
      return json(
        { error: t(locals.locale, 'common.error.noBranch', { branch: project.default_branch }) + where },
        { status: 400 }
      );
    }
  }

  const id = ulid();
  insertRepo({ id, user_id: locals.user.id, project_id, path, origin_url });
  return json({ id, path, projectName: project.name });
};
