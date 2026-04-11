import { json } from '@sveltejs/kit';
import { isAbsolute } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { execa } from 'execa';
import { ulid } from 'ulid';
import type { RequestHandler } from './$types';
import { getProject, insertRepo } from '$lib/server/db/queries';
import { WorktreeManager } from '$lib/server/git/WorktreeManager';

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const project_id = String(b.project_id ?? '').trim();
  const path = String(b.path ?? '').trim();
  const origin_url = String(b.origin_url ?? '').trim() || null;

  const project = getProject(project_id);
  if (!project) return json({ error: 'Project not found' }, { status: 400 });
  if (project.user_id !== locals.user.id) return json({ error: 'Forbidden' }, { status: 403 });

  if (!path) return json({ error: 'Path is required' }, { status: 400 });
  if (!isAbsolute(path)) return json({ error: 'Path must be absolute' }, { status: 400 });
  if (!existsSync(path)) return json({ error: 'Path does not exist on disk' }, { status: 400 });
  if (!statSync(path).isDirectory()) return json({ error: 'Path is not a directory' }, { status: 400 });

  const entries = readdirSync(path);
  if (entries.length === 0) {
    try {
      await WorktreeManager.initEmpty(path, project.default_branch);
    } catch (err) {
      return json(
        { error: `Failed to initialize empty directory as git repo: ${(err as Error).message}` },
        { status: 400 }
      );
    }
  } else {
    try {
      await execa('git', ['-C', path, 'rev-parse', '--git-dir']);
    } catch {
      return json(
        {
          error:
            'Path is not a git repository and is not empty. Either clear the directory or run `git init` yourself.'
        },
        { status: 400 }
      );
    }

    const normalized = await WorktreeManager.ensureDefaultBranch(path, project.default_branch);
    if (normalized.kind === 'no_master') {
      const where = normalized.current ? ` (currently on '${normalized.current}')` : '';
      return json(
        {
          error: `Repo has no branch '${project.default_branch}' and no 'master' branch to rename${where}. Create '${project.default_branch}' manually and try again.`
        },
        { status: 400 }
      );
    }
  }

  const id = ulid();
  insertRepo({ id, user_id: locals.user.id, project_id, path, origin_url });
  return json({ id, path, projectName: project.name });
};
