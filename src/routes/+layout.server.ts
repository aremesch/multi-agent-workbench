import type { LayoutServerLoad } from './$types';
import {
  getSpawnDefaultsAll,
  getUserSetting,
  listAgentCardsForUser,
  listReposWithProjectForUser
} from '$lib/server/db/queries';
import type { AgentStatus } from '$lib/server/db/types';
import {
  DEFAULT_MOBILE_QUICK_KEYS_MODE,
  DEFAULT_THEME,
  MOBILE_QUICK_KEYS_SETTING_KEY,
  SIDEBAR_COLLAPSED_KEY,
  THEME_SETTING_KEY,
  parseMobileQuickKeysMode,
  parseTheme
} from '$lib/shared/dashboard';
import { DEFAULT_LOCALE, type Locale } from '$lib/i18n';
import { getConfig } from '$lib/server/config';
import type { AgentCardRow, SidebarRepoNode } from '$lib/shared/types';
import { hasGitIdentity } from '$lib/server/user/gitIdentity';

const ALL_STATUSES: AgentStatus[] = [
  'spawning',
  'running',
  'waiting_input',
  'idle',
  'exited',
  'crashed'
];

function groupByRepo(agents: AgentCardRow[]): SidebarRepoNode[] {
  const byRepo = new Map<string, SidebarRepoNode>();
  for (const a of agents) {
    let node = byRepo.get(a.repo_id);
    if (!node) {
      node = {
        repoId: a.repo_id,
        repoPath: a.repo_path,
        projectName: a.project_name,
        agents: []
      };
      byRepo.set(a.repo_id, node);
    }
    node.agents.push(a);
  }
  return [...byRepo.values()].sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

function parseCollapsed(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const v = JSON.parse(raw) as { collapsed?: boolean };
    return v.collapsed === true;
  } catch {
    return false;
  }
}

export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.user) {
    return {
      user: null,
      sidebar: null,
      theme: DEFAULT_THEME,
      locale: (locals.locale ?? DEFAULT_LOCALE) as Locale,
      mobileQuickKeysMode: DEFAULT_MOBILE_QUICK_KEYS_MODE
    };
  }
  const cards = listAgentCardsForUser(locals.user.id, ALL_STATUSES);
  const live: AgentCardRow[] = [];
  const archived: AgentCardRow[] = [];
  for (const c of cards) {
    if (c.status === 'exited' || c.status === 'crashed') archived.push(c);
    else live.push(c);
  }
  const liveByRepo = groupByRepo(live);
  const liveIndex = new Map(liveByRepo.map((n) => [n.repoId, n]));
  const allRepos = listReposWithProjectForUser(locals.user.id);
  const activeRepos: SidebarRepoNode[] = allRepos.map(
    (r) =>
      liveIndex.get(r.id) ?? {
        repoId: r.id,
        repoPath: r.path,
        projectName: r.project_name,
        agents: []
      }
  );
  const cliKinds = locals.supervisor.registry.list();
  const spawnDefaults = getSpawnDefaultsAll(
    locals.user.id,
    cliKinds.map((k) => k.kind)
  );

  return {
    user: { id: locals.user.id, username: locals.user.username },
    sidebar: {
      activeRepos,
      archivedRepos: groupByRepo(archived),
      collapsed: parseCollapsed(getUserSetting(locals.user.id, SIDEBAR_COLLAPSED_KEY))
    },
    theme: parseTheme(getUserSetting(locals.user.id, THEME_SETTING_KEY)),
    locale: (locals.locale ?? DEFAULT_LOCALE) as Locale,
    cliKinds,
    spawnDefaults,
    vapidPublicKey: getConfig().vapidPublicKey,
    gitIdentitySet: hasGitIdentity(locals.user.id),
    mobileQuickKeysMode: parseMobileQuickKeysMode(
      getUserSetting(locals.user.id, MOBILE_QUICK_KEYS_SETTING_KEY)
    )
  };
};
