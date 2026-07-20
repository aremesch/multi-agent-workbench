/**
 * Unit tests for the GET /api/agents/:id/changes route.
 *
 * Mocks the DB queries, git helper, and LLM facade so the test runs in pure
 * Node without disk, git, or network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAgentMock = vi.fn();
const getWorktreeMock = vi.fn();
const getAgentChangesMock = vi.fn();
const isConfiguredMock = vi.fn();

vi.mock('$lib/server/db/queries', () => ({
  getAgent: (id: string) => getAgentMock(id),
  getWorktree: (id: string) => getWorktreeMock(id)
}));

vi.mock('$lib/server/git/agentDiff', () => ({
  getAgentChanges: (...args: unknown[]) => getAgentChangesMock(...args)
}));

vi.mock('$lib/server/llm', () => ({
  isConfigured: () => isConfiguredMock()
}));

import { GET } from './+server.js';

async function call(
  opts: { agentId?: string; user?: { id: string } | null } = {}
): Promise<Response> {
  const id = opts.agentId ?? 'agent-1';
  const event = {
    locals: { user: opts.user === undefined ? { id: 'user-1' } : opts.user },
    params: { id }
  };
  return GET(event as unknown as Parameters<typeof GET>[0]);
}

async function expectHttpError(res: Promise<unknown>, status: number): Promise<void> {
  let caught: unknown = null;
  try {
    await res;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected handler to throw').not.toBeNull();
  expect((caught as { status?: number }).status).toBe(status);
}

const CHANGES = {
  committed: { kind: 'committed', files: [], totalAdded: 0, totalRemoved: 0, truncated: false, note: null },
  uncommitted: {
    kind: 'uncommitted',
    files: [],
    totalAdded: 0,
    totalRemoved: 0,
    truncated: false,
    note: null
  },
  baseSha: 'BASE',
  headSha: 'HEAD'
};

beforeEach(() => {
  getAgentMock.mockReset();
  getWorktreeMock.mockReset();
  getAgentChangesMock.mockReset();
  isConfiguredMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/agents/:id/changes — auth + ownership', () => {
  it('401 when not signed in', async () => {
    await expectHttpError(call({ user: null }), 401);
  });

  it('404 when the agent does not exist', async () => {
    getAgentMock.mockReturnValue(undefined);
    await expectHttpError(call(), 404);
  });

  it('403 when the agent belongs to another user', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'other', worktree_id: 'wt-1' });
    await expectHttpError(call(), 403);
  });

  it('404 when the worktree row is missing', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1', worktree_id: 'wt-1' });
    getWorktreeMock.mockReturnValue(undefined);
    await expectHttpError(call(), 404);
  });
});

describe('GET /api/agents/:id/changes — success', () => {
  beforeEach(() => {
    getAgentMock.mockReturnValue({
      id: 'agent-1',
      user_id: 'user-1',
      worktree_id: 'wt-1',
      base_sha: 'BASE'
    });
    getWorktreeMock.mockReturnValue({ id: 'wt-1', path: '/wt' });
    getAgentChangesMock.mockResolvedValue(CHANGES);
  });

  it('returns the changes with aiEnabled=true when configured', async () => {
    isConfiguredMock.mockReturnValue(true);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aiEnabled).toBe(true);
    expect(body.baseSha).toBe('BASE');
    expect(body.committed.kind).toBe('committed');
    expect(getAgentChangesMock).toHaveBeenCalledWith('/wt', 'BASE');
  });

  it('reports aiEnabled=false when no credential is configured', async () => {
    isConfiguredMock.mockReturnValue(false);
    const res = await call();
    const body = await res.json();
    expect(body.aiEnabled).toBe(false);
  });
});
