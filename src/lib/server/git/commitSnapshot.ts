/**
 * Snapshot an agent's git commits into the agent_commits table.
 *
 * Three-tier fallback, in order of preference:
 *   1. committer  — agents spawned after v0.2 have GIT_COMMITTER_EMAIL set;
 *                   `git log --committer=<email>` gives ground-truth
 *                   attribution that survives rebase, cherry-pick, merge.
 *   2. range      — legacy agents without a committer email, but with a
 *                   recorded base_sha: use `git log <base>..<branch>`.
 *   3. merge_base — oldest legacy agents with neither base_sha nor
 *                   committer: fall back to today's heuristic.
 *
 * Never throws: any error is caught and returned as { error }.
 */
import { ulid } from 'ulid';
import {
  getAgent,
  getRepo,
  getWorktree,
  getProject,
  replaceAgentCommits,
  updateAgentCommitSnapshot
} from '../db/queries.js';
import type { AgentCommitSource } from '../db/types.js';
import {
  listCommitsByCommitter,
  listCommitsInRange,
  listAgentCommitsViaMergeBase,
  resolveSha
} from './agentCommits.js';

export type SnapshotResult =
  | { captured: number; source: AgentCommitSource }
  | { error: string };

export async function snapshotAgentCommits(agentId: string): Promise<SnapshotResult> {
  try {
    const agent = getAgent(agentId);
    if (!agent) return { error: `agent ${agentId} not found` };
    const wt = getWorktree(agent.worktree_id);
    if (!wt) return { error: `worktree ${agent.worktree_id} not found` };
    const repo = getRepo(agent.repo_id);
    if (!repo) return { error: `repo ${agent.repo_id} not found` };

    let commits: Awaited<ReturnType<typeof listCommitsByCommitter>> = [];
    let source: AgentCommitSource = 'committer';

    if (agent.committer_email) {
      commits = await listCommitsByCommitter(
        repo.path,
        agent.committer_email,
        agent.base_sha,
        wt.branch
      );
    }

    if (commits.length === 0 && agent.base_sha) {
      const rangeCommits = await listCommitsInRange(repo.path, agent.base_sha, wt.branch);
      if (rangeCommits.length > 0) {
        if (agent.committer_email) {
          console.warn(
            `[commitSnapshot] ${agentId}: committer filter empty, falling back to range — adapter may be stripping GIT_COMMITTER_* env`
          );
        }
        commits = rangeCommits;
        source = 'range';
      } else {
        source = agent.committer_email ? 'committer' : 'range';
      }
    }

    if (commits.length === 0 && !agent.base_sha) {
      // repos now carry default_branch directly (migration 004); fall back
      // through the legacy projects.default_branch for repos attached
      // before that migration, then 'main'.
      const defaultBranch =
        repo.default_branch ??
        (repo.project_id ? getProject(repo.project_id)?.default_branch : null) ??
        'main';
      commits = await listAgentCommitsViaMergeBase(repo.path, wt.branch, defaultBranch);
      source = 'merge_base';
    }

    const headSha = await resolveSha(repo.path, `refs/heads/${wt.branch}`);
    const snapshottedAt = Math.floor(Date.now() / 1000);

    replaceAgentCommits(agent.id, agent.user_id, agent.repo_id, commits, source, () => ulid());
    updateAgentCommitSnapshot(agent.id, headSha, snapshottedAt);

    return { captured: commits.length, source };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
