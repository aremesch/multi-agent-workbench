/**
 * Unit tests for the GET /api/agents/:id/plan route.
 *
 * Mocks every server-side dependency (DB queries, plan helpers) so the
 * test runs in pure Node without disk or DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAgentMock = vi.fn();
const getWorktreeMock = vi.fn();
const resolvePlansDirMock = vi.fn();
const listAgentPlansMock = vi.fn();
const renderAgentPlanMock = vi.fn();

vi.mock('$lib/server/db/queries', () => ({
  getAgent: (id: string) => getAgentMock(id),
  getWorktree: (id: string) => getWorktreeMock(id)
}));

vi.mock('$lib/server/plans/agentPlans', () => ({
  resolvePlansDir: (p: string) => resolvePlansDirMock(p),
  listAgentPlans: (...args: unknown[]) => listAgentPlansMock(...args),
  renderAgentPlan: (...args: unknown[]) => renderAgentPlanMock(...args),
  // displayDir is a pure helper — give it a real implementation so the
  // route's response shape is correct without coupling to internals.
  displayDir: (source: 'local' | 'global', plansDir: string) =>
    source === 'global' ? '~/.claude/plans' : plansDir
}));

import { GET } from './+server.js';

interface CallOpts {
  agentId?: string;
  user?: { id: string } | null;
  fileParam?: string | null;
  sourceParam?: string | null;
}

async function call(opts: CallOpts = {}): Promise<Response> {
  const id = opts.agentId ?? 'agent-1';
  const url = new URL(`http://localhost/api/agents/${id}/plan`);
  if (opts.fileParam !== undefined && opts.fileParam !== null) {
    url.searchParams.set('file', opts.fileParam);
  }
  if (opts.sourceParam !== undefined && opts.sourceParam !== null) {
    url.searchParams.set('source', opts.sourceParam);
  }
  const event = {
    locals: { user: opts.user === undefined ? { id: 'user-1' } : opts.user },
    params: { id },
    url
  };
  return GET(event as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
  getAgentMock.mockReset();
  getWorktreeMock.mockReset();
  resolvePlansDirMock.mockReset();
  listAgentPlansMock.mockReset();
  renderAgentPlanMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

/**
 * SvelteKit's `error()` throws a plain object with `.status` and
 * `.body.message` rather than a regular Error — so `.rejects.toThrow`
 * with a regex against `.message` matches the empty string. Use this
 * helper to assert on the structured shape instead.
 */
async function expectHttpError(
  res: Promise<unknown>,
  status: number
): Promise<{ status: number; body?: { message?: string } }> {
  let caught: unknown = null;
  try {
    await res;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected handler to throw').not.toBeNull();
  const e = caught as { status?: number; body?: { message?: string } };
  expect(e.status).toBe(status);
  return e as { status: number; body?: { message?: string } };
}

describe('GET /api/agents/:id/plan — auth + ownership', () => {
  it('401 when not signed in', async () => {
    await expectHttpError(call({ user: null }), 401);
  });

  it('404 when the agent does not exist', async () => {
    getAgentMock.mockReturnValue(undefined);
    await expectHttpError(call(), 404);
  });

  it('403 when the agent belongs to another user', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'other-user', worktree_id: 'wt-1' });
    await expectHttpError(call(), 403);
  });

  it('404 when the worktree row is missing', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1', worktree_id: 'wt-1' });
    getWorktreeMock.mockReturnValue(undefined);
    await expectHttpError(call(), 404);
  });
});

describe('GET /api/agents/:id/plan — list mode', () => {
  beforeEach(() => {
    getAgentMock.mockReturnValue({
      id: 'agent-1',
      user_id: 'user-1',
      worktree_id: 'wt-1',
      base_sha: 'BASE123',
      created_at: 5_000_000
    });
    getWorktreeMock.mockReturnValue({ id: 'wt-1', path: '/wt' });
    resolvePlansDirMock.mockResolvedValue('docs/plans');
  });

  it('returns 200 with empty files when no plans exist', async () => {
    listAgentPlansMock.mockResolvedValue([]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      dir: 'docs/plans',
      globalDir: '~/.claude/plans',
      files: []
    });
  });

  it('returns the file list when plans exist', async () => {
    listAgentPlansMock.mockResolvedValue([
      { name: 'v0.2-x.md', modifiedMs: 2000, sizeBytes: 50, source: 'local' },
      { name: 'v0.1-y.md', modifiedMs: 1000, sizeBytes: 30, source: 'global' }
    ]);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dir).toBe('docs/plans');
    expect(body.globalDir).toBe('~/.claude/plans');
    expect(body.files).toHaveLength(2);
    expect(body.files[0].name).toBe('v0.2-x.md');
    expect(body.files[0].source).toBe('local');
    expect(body.files[1].source).toBe('global');
  });

  it('forwards base_sha and created_at into listAgentPlans', async () => {
    listAgentPlansMock.mockResolvedValue([]);
    await call();
    expect(listAgentPlansMock).toHaveBeenCalledWith(
      '/wt',
      'docs/plans',
      'BASE123',
      5_000_000
    );
  });

  it('passes null base_sha through unchanged', async () => {
    getAgentMock.mockReturnValue({
      id: 'agent-1',
      user_id: 'user-1',
      worktree_id: 'wt-1',
      base_sha: null,
      created_at: 5_000_000
    });
    listAgentPlansMock.mockResolvedValue([]);
    await call();
    expect(listAgentPlansMock).toHaveBeenCalledWith(
      '/wt',
      'docs/plans',
      null,
      5_000_000
    );
  });
});

describe('GET /api/agents/:id/plan?file=<name> — render mode', () => {
  beforeEach(() => {
    getAgentMock.mockReturnValue({
      id: 'agent-1',
      user_id: 'user-1',
      worktree_id: 'wt-1',
      base_sha: null,
      created_at: 5_000_000
    });
    getWorktreeMock.mockReturnValue({ id: 'wt-1', path: '/wt' });
    resolvePlansDirMock.mockResolvedValue('docs/plans');
  });

  it('returns the rendered HTML and defaults source=local', async () => {
    renderAgentPlanMock.mockResolvedValue({ name: 'plan.md', html: '<h1>x</h1>' });
    const res = await call({ fileParam: 'plan.md' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ name: 'plan.md', html: '<h1>x</h1>' });
    expect(renderAgentPlanMock).toHaveBeenCalledWith(
      '/wt',
      'docs/plans',
      'plan.md',
      'local'
    );
  });

  it('renders from ~/.claude/plans when source=global', async () => {
    renderAgentPlanMock.mockResolvedValue({ name: 'g.md', html: '<p>g</p>' });
    const res = await call({ fileParam: 'g.md', sourceParam: 'global' });
    expect(res.status).toBe(200);
    // For global renders the route doesn't bother reading .claude/settings.json.
    expect(resolvePlansDirMock).not.toHaveBeenCalled();
    expect(renderAgentPlanMock).toHaveBeenCalledWith('/wt', '', 'g.md', 'global');
  });

  it('returns 400 invalid_source when source is anything else', async () => {
    const res = await call({ fileParam: 'plan.md', sourceParam: 'bogus' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_source');
    expect(renderAgentPlanMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the filename fails the safety regex', async () => {
    renderAgentPlanMock.mockRejectedValue(new Error('invalid_filename'));
    const res = await call({ fileParam: '../etc/passwd' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_filename');
  });

  it('returns 404 when renderAgentPlan returns null (file vanished)', async () => {
    renderAgentPlanMock.mockResolvedValue(null);
    const res = await call({ fileParam: 'gone.md' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('plan_not_found');
  });
});
