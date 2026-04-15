import { json } from '@sveltejs/kit';
import { isAbsolute, basename } from 'node:path';
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
  const project_id_raw = String(b.project_id ?? '').trim();
  const project_id: string | null = project_id_raw || null;
  const path = String(b.path ?? '').trim();
  const origin_url = String(b.origin_url ?? '').trim() || null;
  const default_branch_in = String(b.default_branch ?? '').trim();

  let projectName = '';
  let storedDefaultBranch: string | null = default_branch_in || null;
  let effectiveDefaultBranch = default_branch_in || 'main';

  if (project_id) {
    const project = getProject(project_id);
    if (!project) return json({ error: t(locals.locale, 'common.error.projectNotFound') }, { status: 400 });
    if (project.user_id !== locals.user.id) return json({ error: t(locals.locale, 'common.error.forbidden') }, { status: 403 });
    projectName = project.name;
    effectiveDefaultBranch = project.default_branch;
    storedDefaultBranch = null; // inherit from project
  }

  if (!path) return json({ error: t(locals.locale, 'common.error.pathRequired') }, { status: 400 });
  if (!isAbsolute(path)) return json({ error: t(locals.locale, 'common.error.pathNotAbsolute') }, { status: 400 });
  if (!existsSync(path)) return json({ error: t(locals.locale, 'common.error.pathNotExist') }, { status: 400 });
  if (!statSync(path).isDirectory()) return json({ error: t(locals.locale, 'common.error.pathNotDir') }, { status: 400 });

  const entries = readdirSync(path);
  if (entries.length === 0) {
    try {
      await WorktreeManager.initEmpty(path, effectiveDefaultBranch);
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

    const normalized = await WorktreeManager.ensureDefaultBranch(path, effectiveDefaultBranch);
    if (normalized.kind === 'no_master') {
      const where = normalized.current ? ` (currently on '${normalized.current}')` : '';
      return json(
        { error: t(locals.locale, 'common.error.noBranch', { branch: effectiveDefaultBranch }) + where },
        { status: 400 }
      );
    }
  }

  const id = ulid();
  insertRepo({
    id,
    user_id: locals.user.id,
    project_id,
    path,
    origin_url,
    default_branch: storedDefaultBranch
  });
  return json({ id, path, projectName: projectName || basename(path) });
};
