import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
  getRepo,
  getSpawnDefaultsAll,
  getUserSetting,
  listAgentCardsForRepo,
  listProjects,
  listReposForProject,
  listRoles
} from '$lib/server/db/queries';
import type { AgentStatus } from '$lib/server/db/types';
import { repoDashboardLayoutKey } from '$lib/shared/dashboard';
import type { LayoutEntry } from '$lib/shared/types';

const LIVE_STATUSES: AgentStatus[] = ['spawning', 'running', 'waiting_input', 'idle'];

interface DashboardRepoOption {
  id: string;
  path: string;
  projectName: string;
}
interface DashboardRoleOption {
  id: string;
  name: string;
  cli_kind: string;
}

function loadRepoOptions(userId: string): DashboardRepoOption[] {
  const options: DashboardRepoOption[] = [];
  for (const project of listProjects(userId)) {
    for (const repo of listReposForProject(project.id)) {
      options.push({ id: repo.id, path: repo.path, projectName: project.name });
    }
  }
  return options;
}

function parseLayout(raw: string | null): LayoutEntry[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { layout?: LayoutEntry[] };
    return Array.isArray(parsed.layout) ? parsed.layout : null;
  } catch {
    return null;
  }
}

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(303, '/login');
  const repo = getRepo(params.id);
  if (!repo || repo.user_id !== locals.user.id) throw error(404, 'Repo not found');
  const layoutKey = repoDashboardLayoutKey(repo.id);
  const liveAgents = listAgentCardsForRepo(locals.user.id, repo.id, LIVE_STATUSES);
  const dashboardLayout = parseLayout(getUserSetting(locals.user.id, layoutKey));
  const spawnRoles: DashboardRoleOption[] = listRoles(locals.user.id).map((r) => ({
    id: r.id,
    name: r.name,
    cli_kind: r.cli_kind
  }));
  const spawnRepos = loadRepoOptions(locals.user.id);
  const spawnProjects = listProjects(locals.user.id);
  const spawnCliKinds = locals.supervisor.registry.list();
  const spawnDefaults = getSpawnDefaultsAll(
    locals.user.id,
    spawnCliKinds.map((k) => k.kind)
  );
  return {
    repo: { id: repo.id, path: repo.path },
    layoutKey,
    liveAgents,
    dashboardLayout,
    spawnRoles,
    spawnRepos,
    spawnProjects,
    spawnCliKinds,
    spawnDefaults
  };
};
