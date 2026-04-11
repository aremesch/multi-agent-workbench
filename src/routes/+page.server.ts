import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
  getUserSetting,
  listAgentCardsForUser,
  listProjects,
  listReposForProject,
  listRoles
} from '$lib/server/db/queries';
import type { AgentStatus } from '$lib/server/db/types';
import { DASHBOARD_LAYOUT_KEY } from '$lib/shared/dashboard';
import type { LayoutEntry } from '$lib/shared/types';

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

const LIVE_STATUSES: AgentStatus[] = ['spawning', 'running', 'waiting_input', 'idle'];
const ARCHIVED_STATUSES: AgentStatus[] = ['exited', 'crashed'];

function parseLayout(raw: string | null): LayoutEntry[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { layout?: LayoutEntry[] };
    return Array.isArray(parsed.layout) ? parsed.layout : null;
  } catch {
    return null;
  }
}

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');
  const liveAgents = listAgentCardsForUser(locals.user.id, LIVE_STATUSES);
  const archivedAgents = listAgentCardsForUser(locals.user.id, ARCHIVED_STATUSES);
  const dashboardLayout = parseLayout(
    getUserSetting(locals.user.id, DASHBOARD_LAYOUT_KEY)
  );
  // Loaded eagerly so the spawn-agent modal on the dashboard doesn't need a
  // separate /agents/new round-trip before it can render its form.
  const spawnRoles: DashboardRoleOption[] = listRoles(locals.user.id).map((r) => ({
    id: r.id,
    name: r.name,
    cli_kind: r.cli_kind
  }));
  const spawnRepos = loadRepoOptions(locals.user.id);
  const spawnProjects = listProjects(locals.user.id);
  const spawnCliKinds = locals.supervisor.registry.list();
  return {
    liveAgents,
    archivedAgents,
    dashboardLayout,
    spawnRoles,
    spawnRepos,
    spawnProjects,
    spawnCliKinds
  };
};
