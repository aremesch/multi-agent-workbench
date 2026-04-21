/**
 * GET  /api/agents/:id/commits — read persisted commits from agent_commits.
 * POST /api/agents/:id/commits — re-run snapshotAgentCommits and return
 *                                the fresh persisted rows.
 *
 * Both require ownership of the agent, matching the sibling DELETE route.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent, listPersistedAgentCommits } from '$lib/server/db/queries';
import { snapshotAgentCommits } from '$lib/server/git/commitSnapshot';
import type { AgentCommit, AgentCommitSource } from '$lib/shared/types';
import type { AgentCommitRow } from '$lib/server/db/types';

function rowToCommit(row: AgentCommitRow): AgentCommit {
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
    body: row.body
  };
}

export interface AgentCommitsResponse {
  commits: AgentCommit[];
  snapshottedAt: number | null;
  headShaAtSnapshot: string | null;
  source: AgentCommitSource | null;
}

function buildResponse(agentId: string, snapshottedAt: number | null, headSha: string | null): AgentCommitsResponse {
  const rows = listPersistedAgentCommits(agentId);
  return {
    commits: rows.map(rowToCommit),
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

  return json(buildResponse(agent.id, agent.commits_snapshotted_at, agent.head_sha_at_snapshot));
};

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  const result = await snapshotAgentCommits(agent.id);
  if ('error' in result) {
    return json({ error: result.error }, { status: 500 });
  }

  // Re-read agent for updated snapshot timestamps.
  const refreshed = getAgent(agent.id)!;
  return json(
    buildResponse(refreshed.id, refreshed.commits_snapshotted_at, refreshed.head_sha_at_snapshot)
  );
};
