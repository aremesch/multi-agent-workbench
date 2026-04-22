import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks for the db layer and sibling git module. Declared before the
// SUT import so the module registry sees them first.
const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getRepo: vi.fn(),
  getWorktree: vi.fn(),
  getProject: vi.fn(),
  listPersistedAgentCommits: vi.fn(),
  replaceAgentCommits: vi.fn(),
  updateAgentCommitSnapshot: vi.fn(),
  listCommitsByCommitter: vi.fn(),
  listCommitsInRange: vi.fn(),
  listAgentCommitsViaMergeBase: vi.fn(),
  resolveSha: vi.fn(),
  revParseQuiet: vi.fn(),
  catFileExists: vi.fn()
}));

vi.mock('../db/queries.js', () => ({
  getAgent: mocks.getAgent,
  getRepo: mocks.getRepo,
  getWorktree: mocks.getWorktree,
  getProject: mocks.getProject,
  listPersistedAgentCommits: mocks.listPersistedAgentCommits,
  replaceAgentCommits: mocks.replaceAgentCommits,
  updateAgentCommitSnapshot: mocks.updateAgentCommitSnapshot
}));

vi.mock('./agentCommits.js', () => ({
  listCommitsByCommitter: mocks.listCommitsByCommitter,
  listCommitsInRange: mocks.listCommitsInRange,
  listAgentCommitsViaMergeBase: mocks.listAgentCommitsViaMergeBase,
  resolveSha: mocks.resolveSha,
  revParseQuiet: mocks.revParseQuiet,
  catFileExists: mocks.catFileExists
}));

import { snapshotAgentCommits } from './commitSnapshot.js';

const baseAgent = {
  id: 'agt',
  user_id: 'u',
  repo_id: 'r',
  worktree_id: 'w',
  base_sha: 'BASE',
  committer_email: 'agt@maw.local'
};
const baseRepo = { id: 'r', path: '/repo', default_branch: 'main', project_id: null };
const baseWt = { id: 'w', branch: 'maw/agt', path: '/worktrees/agt' };

beforeEach(() => {
  for (const m of Object.values(mocks)) (m as ReturnType<typeof vi.fn>).mockReset();
  mocks.getAgent.mockReturnValue(baseAgent);
  mocks.getRepo.mockReturnValue(baseRepo);
  mocks.getWorktree.mockReturnValue(baseWt);
  mocks.resolveSha.mockResolvedValue('HEAD_SHA');
});

describe('snapshotAgentCommits', () => {
  it('captures commits via committer filter (happy path)', async () => {
    mocks.listCommitsByCommitter.mockResolvedValue([
      { sha: 'a', shortSha: 'a', parentShas: [], author: 'A', authorName: 'A', authorEmail: '',
        committerName: 'A', committerEmail: 'agt@maw.local', authoredAt: 1, committedAt: 1,
        date: 'd', subject: 's', body: '', reachable: true }
    ]);
    const res = await snapshotAgentCommits('agt');
    expect(res).toEqual({ captured: 1, source: 'committer' });
    expect(mocks.replaceAgentCommits).toHaveBeenCalledOnce();
    expect(mocks.updateAgentCommitSnapshot).toHaveBeenCalledWith('agt', 'HEAD_SHA', expect.any(Number));
  });

  it('preserves existing rows when git log empty AND branch missing AND base missing', async () => {
    mocks.listCommitsByCommitter.mockResolvedValue([]);
    mocks.listCommitsInRange.mockResolvedValue([]);
    mocks.listPersistedAgentCommits.mockReturnValue([{ sha: 'old' }]);
    mocks.revParseQuiet.mockResolvedValue(false); // branch gone
    mocks.catFileExists.mockResolvedValue(false); // base GC'd

    const res = await snapshotAgentCommits('agt');
    expect(res).toEqual({ preserved: 1, reason: 'empty-unreachable' });
    expect(mocks.replaceAgentCommits).not.toHaveBeenCalled();
    // Snapshot timestamp still bumped so legacy back-fill guard flips.
    expect(mocks.updateAgentCommitSnapshot).toHaveBeenCalledWith('agt', null, expect.any(Number));
  });

  it('still wipes when commits empty but branch exists (genuine no-op agent)', async () => {
    mocks.listCommitsByCommitter.mockResolvedValue([]);
    mocks.listCommitsInRange.mockResolvedValue([]);
    mocks.listPersistedAgentCommits.mockReturnValue([]); // nothing to preserve anyway
    mocks.revParseQuiet.mockResolvedValue(true);
    mocks.catFileExists.mockResolvedValue(true);

    const res = await snapshotAgentCommits('agt');
    expect('captured' in res).toBe(true);
    expect(mocks.replaceAgentCommits).toHaveBeenCalledOnce();
  });

  it('does NOT preserve when existing rows empty (nothing to protect)', async () => {
    mocks.listCommitsByCommitter.mockResolvedValue([]);
    mocks.listCommitsInRange.mockResolvedValue([]);
    mocks.listPersistedAgentCommits.mockReturnValue([]);
    mocks.revParseQuiet.mockResolvedValue(false);
    mocks.catFileExists.mockResolvedValue(false);

    const res = await snapshotAgentCommits('agt');
    expect('captured' in res).toBe(true);
    expect(mocks.replaceAgentCommits).toHaveBeenCalledOnce();
  });

  it('does NOT preserve when branch gone but base still reachable (range fallback viable)', async () => {
    mocks.listCommitsByCommitter.mockResolvedValue([]);
    mocks.listCommitsInRange.mockResolvedValue([]);
    mocks.listPersistedAgentCommits.mockReturnValue([{ sha: 'old' }]);
    mocks.revParseQuiet.mockResolvedValue(false); // branch gone
    mocks.catFileExists.mockResolvedValue(true); // base still present

    const res = await snapshotAgentCommits('agt');
    // anchorsGone = !branch && (!base || !baseExists) = !false && (false || !true) = true && false = false
    expect('captured' in res).toBe(true);
    expect(mocks.replaceAgentCommits).toHaveBeenCalledOnce();
  });
});
