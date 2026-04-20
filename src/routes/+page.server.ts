import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
  getSpawnDefaultsAll,
  getUserSetting,
  listAgentCardsForUser,
  listReposWithProjectForUser,
  listRoles
} from '$lib/server/db/queries';
import type { AgentStatus } from '$lib/server/db/types';
import { DASHBOARD_LAYOUT_KEY } from '$lib/shared/dashboard';
import type { LayoutEntry } from '$lib/shared/types';

interface DashboardRepoOption {
  id: string;
  path: string;
  projectName: string | null;
}

interface DashboardRoleOption {
  id: string;
  name: string;
  cli_kind: string;
}

function loadRepoOptions(userId: string): DashboardRepoOption[] {
  return listReposWithProjectForUser(userId).map((r) => ({
    id: r.id,
    path: r.path,
    projectName: r.project_name
  }));
}

const LIVE_STATUSES: AgentStatus[] = ['spawning', 'running', 'waiting_input', 'idle'];

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
  const spawnCliKinds = locals.supervisor.registry.list();
  const spawnDefaults = getSpawnDefaultsAll(
    locals.user.id,
    spawnCliKinds.map((k) => k.kind)
  );
  return {
    liveAgents,
    dashboardLayout,
    spawnRoles,
    spawnRepos,
    spawnCliKinds,
    spawnDefaults
  };
};
