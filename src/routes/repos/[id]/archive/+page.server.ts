import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
  getLatestRunForAgent,
  getRepo,
  getWorktree,
  listAgentCardsForRepo,
  listPersistedAgentCommits,
  summarizeTerminalActivity,
  type AgentCardRow,
  type TerminalActivitySummary
} from '$lib/server/db/queries';
import type { AgentCommitRow, AgentRunRow, AgentStatus } from '$lib/server/db/types';
import {
  summarizeTokenUsage,
  jsonlPathFor,
  type TokenUsageSummary
} from '$lib/server/agents/history/ClaudeJsonlTokens';
import { snapshotAgentCommits } from '$lib/server/git/commitSnapshot';
import { checkShaReachability } from '$lib/server/git/agentCommits';
import { parseRemoteUrl } from '$lib/server/git/remoteUrl';
import type { AgentCommit, AgentRemote } from '$lib/shared/types';

const ARCHIVED_STATUSES: AgentStatus[] = ['exited', 'crashed'];

export interface ArchivedAgentEntry {
  agent: AgentCardRow;
  run: AgentRunRow | null;
  stats: TerminalActivitySummary;
  totalSec: number | null;
  tokens: TokenUsageSummary | null;
  commits: AgentCommit[];
}

export interface ArchiveTotals {
  totalSec: number;
  activeSec: number;
  idleSec: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Rows that contributed a non-null token summary; lets the UI render '—' when nothing did. */
  tokenRowCount: number;
}

function sumTotals(entries: ArchivedAgentEntry[]): ArchiveTotals {
  const totals: ArchiveTotals = {
    totalSec: 0,
    activeSec: 0,
    idleSec: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tokenRowCount: 0
  };
  for (const e of entries) {
    totals.totalSec += e.totalSec ?? 0;
    totals.activeSec += e.stats.activeSec ?? 0;
    totals.idleSec += e.stats.idleSec ?? 0;
    if (e.tokens) {
      totals.inputTokens += e.tokens.inputTokens ?? 0;
      totals.outputTokens += e.tokens.outputTokens ?? 0;
      totals.cacheCreationTokens += e.tokens.cacheCreationTokens ?? 0;
      totals.cacheReadTokens += e.tokens.cacheReadTokens ?? 0;
      totals.tokenRowCount += 1;
    }
  }
  return totals;
}

function rowToCommit(row: AgentCommitRow, reachable: boolean): AgentCommit {
  let parents: string[] = [];
  try {
    parents = JSON.parse(row.parent_shas) as string[];
  } catch {
    parents = [];
  }
  return {
    sha: row.sha,
    shortSha: row.sha.slice(0, 7),
    parentShas: parents,
    author: row.author_email
      ? `${row.author_name} <${row.author_email}>`
      : row.author_name,
    authorName: row.author_name,
    authorEmail: row.author_email,
    committerName: row.committer_name,
    committerEmail: row.committer_email,
    authoredAt: row.authored_at,
    committedAt: row.committed_at,
    date: new Date(row.authored_at * 1000).toISOString(),
    subject: row.subject,
    body: row.body,
    reachable
  };
}

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(303, '/login');
  const repo = getRepo(params.id);
  if (!repo || repo.user_id !== locals.user.id) throw error(404, 'Repo not found');

  const remote: AgentRemote | null = parseRemoteUrl(repo.origin_url);

  const agents = listAgentCardsForRepo(locals.user.id, repo.id, ARCHIVED_STATUSES);

  const preCommit = await Promise.all(
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

      // Read persisted commits from agent_commits. Legacy agents that
      // were never snapshotted get a one-shot back-fill on first visit;
      // subsequent loads are DB-only. The `commits_snapshotted_at ==
      // null` guard is load-bearing: without it, genuinely-empty-commit
      // agents would re-run git on every archive load forever.
      let rows = listPersistedAgentCommits(a.id);
      if (rows.length === 0 && a.commits_snapshotted_at == null) {
        const r = await snapshotAgentCommits(a.id);
        if (!('error' in r)) {
          rows = listPersistedAgentCommits(a.id);
        }
      }
      return { agent: a, run, stats, totalSec, tokens, rows };
    })
  );

  // One cat-file --batch-check pass across every stored SHA in the repo,
  // instead of N git invocations. Gives each commit a `reachable` flag
  // the UI uses to render stale links with a muted/strikethrough style.
  const allShas = preCommit.flatMap((p) => p.rows.map((r) => r.sha));
  const reachable = await checkShaReachability(repo.path, allShas);

  const entries: ArchivedAgentEntry[] = preCommit.map((p) => ({
    agent: p.agent,
    run: p.run,
    stats: p.stats,
    totalSec: p.totalSec,
    tokens: p.tokens,
    commits: p.rows.map((r) => rowToCommit(r, reachable.has(r.sha)))
  }));

  return {
    repo: { id: repo.id, path: repo.path },
    remote,
    archivedAgents: entries,
    totals: sumTotals(entries)
  };
};
