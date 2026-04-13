import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
  getLatestRunForAgent,
  getRepo,
  getWorktree,
  listAgentCardsForRepo,
  summarizeTerminalActivity,
  type AgentCardRow,
  type TerminalActivitySummary
} from '$lib/server/db/queries';
import type { AgentRunRow, AgentStatus } from '$lib/server/db/types';
import {
  summarizeTokenUsage,
  jsonlPathFor,
  type TokenUsageSummary
} from '$lib/server/agents/history/ClaudeJsonlTokens';

const ARCHIVED_STATUSES: AgentStatus[] = ['exited', 'crashed'];

export interface ArchivedAgentEntry {
  agent: AgentCardRow;
  run: AgentRunRow | null;
  stats: TerminalActivitySummary;
  totalSec: number | null;
  tokens: TokenUsageSummary | null;
}

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(303, '/login');
  const repo = getRepo(params.id);
  if (!repo || repo.user_id !== locals.user.id) throw error(404, 'Repo not found');

  const agents = listAgentCardsForRepo(locals.user.id, repo.id, ARCHIVED_STATUSES);

  const entries: ArchivedAgentEntry[] = await Promise.all(
    agents.map(async (a) => {
      const run = getLatestRunForAgent(a.id) ?? null;
      const stats = summarizeTerminalActivity(a.id);
      const startedAt = run?.started_at ?? a.created_at;
      const endedAt = run?.ended_at ?? a.updated_at;
      const totalSec = endedAt && startedAt ? endedAt - startedAt : null;

      let tokens: TokenUsageSummary | null = null;
      if (a.cli_session_id) {
        const wt = getWorktree(a.worktree_id);
        if (wt) {
          const path = jsonlPathFor(wt.path, a.cli_session_id);
          tokens = await summarizeTokenUsage(path);
        }
      }

      return { agent: a, run, stats, totalSec, tokens };
    })
  );

  return {
    repo: { id: repo.id, path: repo.path },
    archivedAgents: entries
  };
};
