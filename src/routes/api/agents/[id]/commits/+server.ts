/**
 * GET  /api/agents/:id/commits — read persisted commits from agent_commits.
 * POST /api/agents/:id/commits — re-run snapshotAgentCommits and return
 *                                the fresh persisted rows.
 *
 * Both require ownership of the agent, matching the sibling DELETE route.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent, getRepo, listPersistedAgentCommits } from '$lib/server/db/queries';
import { snapshotAgentCommits } from '$lib/server/git/commitSnapshot';
import { checkShaReachability } from '$lib/server/git/agentCommits';
import type { AgentCommit, AgentCommitSource } from '$lib/shared/types';
import type { AgentCommitRow } from '$lib/server/db/types';

function rowToCommit(row: AgentCommitRow, reachable: boolean): AgentCommit {
  let parents: string[] = [];
  try {
    parents = JSON.parse(row.parent_shas) as string[];
  } catch {
    parents = [];
  }
  const authorEmail = row.author_email;
  return {
    sha: row.sha,
    shortSha: row.sha.slice(0, 7),
    parentShas: parents,
    author: authorEmail ? `${row.author_name} <${authorEmail}>` : row.author_name,
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

export interface AgentCommitsResponse {
  commits: AgentCommit[];
  snapshottedAt: number | null;
  headShaAtSnapshot: string | null;
  source: AgentCommitSource | null;
  /** Present when the refresh preserved existing rows (branch/base gone). */
  preserved?: number;
  preservedReason?: 'branch-missing' | 'base-missing' | 'empty-unreachable';
  /** Count of commits captured by a fresh snapshot, when applicable. */
  captured?: number;
}

async function buildResponse(
  agentId: string,
  repoPath: string,
  snapshottedAt: number | null,
  headSha: string | null
): Promise<AgentCommitsResponse> {
  const rows = listPersistedAgentCommits(agentId);
  const reachable = await checkShaReachability(
    repoPath,
    rows.map((r) => r.sha)
  );
  return {
    commits: rows.map((r) => rowToCommit(r, reachable.has(r.sha))),
    snapshottedAt,
    headShaAtSnapshot: headSha,
    source: (rows[0]?.source ?? null) as AgentCommitSource | null
  };
}

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');
  const repo = getRepo(agent.repo_id);
  if (!repo) throw error(404, 'Repo not found');

  return json(
    await buildResponse(
      agent.id,
      repo.path,
      agent.commits_snapshotted_at,
      agent.head_sha_at_snapshot
    )
  );
};

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');
  const repo = getRepo(agent.repo_id);
  if (!repo) throw error(404, 'Repo not found');

  const result = await snapshotAgentCommits(agent.id);
  if ('error' in result) {
    return json({ error: result.error }, { status: 500 });
  }

  // Re-read agent for updated snapshot timestamps.
  const refreshed = getAgent(agent.id)!;
  const base = await buildResponse(
    refreshed.id,
    repo.path,
    refreshed.commits_snapshotted_at,
    refreshed.head_sha_at_snapshot
  );
  if ('preserved' in result) {
    return json({ ...base, preserved: result.preserved, preservedReason: result.reason });
  }
  return json({ ...base, captured: result.captured });
};
