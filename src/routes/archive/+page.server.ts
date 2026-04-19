import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
  getLatestRunForAgent,
  getWorktree,
  listAgentCardsForUser,
  summarizeTerminalActivity,
  type AgentCardRow
} from '$lib/server/db/queries';
import type { AgentStatus } from '$lib/server/db/types';
import {
  summarizeTokenUsage,
  jsonlPathFor
} from '$lib/server/agents/history/ClaudeJsonlTokens';

const ARCHIVED_STATUSES: AgentStatus[] = ['exited', 'crashed'];

export interface ArchiveRepoSummary {
  repo: {
    id: string;
    path: string;
    projectName: string;
  };
  archivedCount: number;
  totals: {
    totalSec: number;
    activeSec: number;
    idleSec: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    tokenRowCount: number;
  };
}

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, '/login');

  const agents = listAgentCardsForUser(locals.user.id, ARCHIVED_STATUSES);

  // Group by repo. Use a Map keyed by repo_id so insertion order is
  // preserved (agents come in created_at DESC; first-seen repo stays on top).
  const byRepo = new Map<string, { repo: AgentCardRow; agents: AgentCardRow[] }>();
  for (const a of agents) {
    const existing = byRepo.get(a.repo_id);
    if (existing) {
      existing.agents.push(a);
    } else {
      byRepo.set(a.repo_id, { repo: a, agents: [a] });
    }
  }

  const summaries: ArchiveRepoSummary[] = await Promise.all(
    [...byRepo.values()].map(async ({ repo, agents: repoAgents }) => {
      const totals = {
        totalSec: 0,
        activeSec: 0,
        idleSec: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tokenRowCount: 0
      };

      for (const a of repoAgents) {
        const run = getLatestRunForAgent(a.id) ?? null;
        const stats = summarizeTerminalActivity(a.id);
        const startedAt = run?.started_at ?? a.created_at;
        const endedAt = run?.ended_at ?? a.updated_at;
        if (endedAt && startedAt) totals.totalSec += endedAt - startedAt;
        totals.activeSec += stats.activeSec ?? 0;
        totals.idleSec += stats.idleSec ?? 0;

        if (a.cli_session_id) {
          const wt = getWorktree(a.worktree_id);
          if (wt) {
            const path = jsonlPathFor(wt.path, a.cli_session_id);
            const tokens = await summarizeTokenUsage(path);
            if (tokens) {
              totals.inputTokens += tokens.inputTokens ?? 0;
              totals.outputTokens += tokens.outputTokens ?? 0;
              totals.cacheCreationTokens += tokens.cacheCreationTokens ?? 0;
              totals.cacheReadTokens += tokens.cacheReadTokens ?? 0;
              totals.tokenRowCount += 1;
            }
          }
        }
      }

      return {
        repo: {
          id: repo.repo_id,
          path: repo.repo_path,
          projectName: repo.project_name
        },
        archivedCount: repoAgents.length,
        totals
      };
    })
  );

  // Sort by total time desc (busiest repos first).
  summaries.sort((a, b) => b.totals.totalSec - a.totals.totalSec);

  // Grand totals across every repo.
  const grand = {
    totalSec: 0,
    activeSec: 0,
    idleSec: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tokenRowCount: 0,
    archivedCount: 0
  };
  for (const s of summaries) {
    grand.totalSec += s.totals.totalSec;
    grand.activeSec += s.totals.activeSec;
    grand.idleSec += s.totals.idleSec;
    grand.inputTokens += s.totals.inputTokens;
    grand.outputTokens += s.totals.outputTokens;
    grand.cacheCreationTokens += s.totals.cacheCreationTokens;
    grand.cacheReadTokens += s.totals.cacheReadTokens;
    grand.tokenRowCount += s.totals.tokenRowCount;
    grand.archivedCount += s.archivedCount;
  }

  return { summaries, grand };
};
