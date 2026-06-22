import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const insertRunMock = vi.fn();
const startPlanningMock = vi.fn();
const getRepoMock = vi.fn();
const getRoleMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({ verifyCsrf: (e: unknown) => verifyCsrfMock(e) }));
vi.mock('$lib/server/bootstrap', () => ({ getEngine: () => ({ startPlanning: startPlanningMock }) }));
vi.mock('$lib/server/db/queries', () => ({
  getRepo: (...a: unknown[]) => getRepoMock(...a),
  getRole: (...a: unknown[]) => getRoleMock(...a),
  getSupervisorSettings: () => ({ fixLoopCap: 3 }),
  insertSupervisorRun: (...a: unknown[]) => insertRunMock(...a),
  listSupervisorRunsForUser: () => []
}));

import { POST } from './+server.js';

async function call(body: unknown, user: { id: string } | null = { id: 'u1' }): Promise<Response> {
  const request = new Request('http://localhost/api/supervisor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const event = { locals: { user, locale: 'en' }, request, cookies: { get: () => undefined } };
  return (await POST(event as unknown as Parameters<typeof POST>[0])) as Response;
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  insertRunMock.mockReset();
  startPlanningMock.mockReset();
  getRepoMock.mockReset().mockReturnValue({ id: 'r1', user_id: 'u1', default_branch: 'main' });
  getRoleMock.mockReset().mockReturnValue({ id: 'role', user_id: 'u1' });
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/supervisor', () => {
  it('401s when unauthenticated', async () => {
    const res = await call({ title: 'x', planMd: 'p', repoId: 'r1', roleId: 'a', qcRoleId: 'b' }, null);
    expect(res.status).toBe(401);
  });

  it('400s on missing title/plan', async () => {
    const res = await call({ repoId: 'r1', roleId: 'a', qcRoleId: 'b' });
    expect(res.status).toBe(400);
    expect(insertRunMock).not.toHaveBeenCalled();
  });

  it('400s when the repo is not owned by the caller', async () => {
    getRepoMock.mockReturnValue({ id: 'r1', user_id: 'someone-else' });
    const res = await call({ title: 't', planMd: 'p', repoId: 'r1', roleId: 'a', qcRoleId: 'b' });
    expect(res.status).toBe(400);
  });

  it('creates the run and kicks off planning', async () => {
    const res = await call({ title: 't', planMd: 'plan', repoId: 'r1', roleId: 'a', qcRoleId: 'b' });
    expect(res.status).toBe(201);
    expect(insertRunMock).toHaveBeenCalledOnce();
    const arg = insertRunMock.mock.calls[0]![0] as { phase: string; config_json: string };
    expect(arg.phase).toBe('planning');
    expect(JSON.parse(arg.config_json)).toMatchObject({ fixLoopCap: 3 });
    expect(startPlanningMock).toHaveBeenCalledOnce();
  });
});
