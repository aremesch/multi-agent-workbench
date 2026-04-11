import { error, fail, redirect } from '@sveltejs/kit';
import { isAbsolute } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { execa } from 'execa';
import { ulid } from 'ulid';
import type { Actions, PageServerLoad } from './$types';
import { getProject, insertRepo } from '$lib/server/db/queries';
import { WorktreeManager } from '$lib/server/git/WorktreeManager';

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(303, '/login');
  const project = getProject(params.id);
  if (!project) throw error(404, 'Project not found');
  if (project.user_id !== locals.user.id) throw error(403, 'Forbidden');
  return { project };
};

export const actions: Actions = {
  default: async ({ request, locals, params }) => {
    if (!locals.user) throw redirect(303, '/login');
    const project = getProject(params.id);
    if (!project) throw error(404, 'Project not found');
    if (project.user_id !== locals.user.id) throw error(403, 'Forbidden');

    const form = await request.formData();
    const path = String(form.get('path') ?? '').trim();
    const origin_url_raw = String(form.get('origin_url') ?? '').trim();
    const origin_url = origin_url_raw || null;

    if (!path) {
      return fail(400, { path, origin_url: origin_url_raw, error: 'Path is required' });
    }
    if (!isAbsolute(path)) {
      return fail(400, {
        path,
        origin_url: origin_url_raw,
        error: 'Path must be absolute'
      });
    }
    if (!existsSync(path)) {
      return fail(400, {
        path,
        origin_url: origin_url_raw,
        error: 'Path does not exist on disk'
      });
    }
    if (!statSync(path).isDirectory()) {
      return fail(400, {
        path,
        origin_url: origin_url_raw,
        error: 'Path is not a directory'
      });
    }

    // Bring the target directory into a state where project.default_branch
    // exists as a branch with at least one commit behind it, so downstream
    // worktree creation always resolves its start point. Three acceptable
    // initial states:
    //
    //  1. Empty directory    → MAW runs `git init -b <default_branch>` and
    //                          creates an empty initial commit.
    //  2. Existing git repo  → WorktreeManager.ensureDefaultBranch rewires
    //                          it (exists / renamed / seeded / no_master).
    //  3. Non-empty non-git  → rejected to avoid accidentally tracking an
    //                          arbitrary pile of user files.
    const entries = readdirSync(path);
    if (entries.length === 0) {
      try {
        await WorktreeManager.initEmpty(path, project.default_branch);
        console.log(
          `[maw] repo attach: initialized empty dir as git repo on branch '${project.default_branch}' at ${path}`
        );
      } catch (err) {
        return fail(400, {
          path,
          origin_url: origin_url_raw,
          error: `Failed to initialize empty directory as git repo: ${(err as Error).message}`
        });
      }
    } else {
      try {
        await execa('git', ['-C', path, 'rev-parse', '--git-dir']);
      } catch {
        return fail(400, {
          path,
          origin_url: origin_url_raw,
          error:
            'Path is not a git repository and is not empty. Either clear the directory or run `git init` yourself.'
        });
      }

      const normalized = await WorktreeManager.ensureDefaultBranch(
        path,
        project.default_branch
      );
      if (normalized.kind === 'renamed') {
        console.log(
          `[maw] repo attach: renamed ${normalized.from} → ${project.default_branch} in ${path}`
        );
      } else if (normalized.kind === 'seeded') {
        console.log(
          `[maw] repo attach: seeded unborn repo with initial commit on '${project.default_branch}' at ${path}`
        );
      } else if (normalized.kind === 'no_master') {
        const where = normalized.current ? ` (currently on '${normalized.current}')` : '';
        return fail(400, {
          path,
          origin_url: origin_url_raw,
          error: `Repo has no branch '${project.default_branch}' and no 'master' branch to rename${where}. Create '${project.default_branch}' manually and try again.`
        });
      }
    }

    const id = ulid();
    insertRepo({
      id,
      user_id: locals.user.id,
      project_id: project.id,
      path,
      origin_url
    });
    throw redirect(303, `/projects/${project.id}`);
  }
};
