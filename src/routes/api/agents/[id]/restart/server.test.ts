import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const getAgentMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  getAgent: (id: string) => getAgentMock(id)
}));

import { POST } from './+server.js';

type RestartResult =
  | { ok: true; mode: 'resume' | 'fresh'; row: { id: string } }
  | { ok: false; code: string; message?: string };

interface Opts {
  user?: { id: string } | null;
  agent?: { id: string; user_id: string; status: string } | null;
  restartResult?: RestartResult;
  csrfThrows?: boolean;
}

function buildEvent(opts: Opts): { event: unknown; restart: ReturnType<typeof vi.fn> } {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  if (opts.agent !== undefined) getAgentMock.mockReturnValueOnce(opts.agent);
  const restart = vi.fn(async () => opts.restartResult);
  const event = {
    locals: {
      user: opts.user === undefined ? { id: 'user-1' } : opts.user,
      supervisor: { restart }
    },
    params: { id: 'agent-1' },
    request: new Request('http://localhost/api/agents/agent-1/restart', { method: 'POST' }),
    cookies: { get: () => undefined }
  };
  return { event, restart };
}

const crashed = { id: 'agent-1', user_id: 'user-1', status: 'crashed' };

beforeEach(() => {
  verifyCsrfMock.mockReset();
  getAgentMock.mockReset();
});

describe('POST /api/agents/:id/restart', () => {
  it('401 when unauthenticated', async () => {
    const { event } = buildEvent({ user: null, agent: crashed });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(POST(event as any)).rejects.toMatchObject({ status: 401 });
  });

  it('404 when the agent does not exist', async () => {
    const { event } = buildEvent({ agent: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(POST(event as any)).rejects.toMatchObject({ status: 404 });
  });

  it('403 when the agent belongs to another user', async () => {
    const { event } = buildEvent({ agent: { ...crashed, user_id: 'someone-else' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(POST(event as any)).rejects.toMatchObject({ status: 403 });
  });

  it('409 not_crashed without calling the supervisor', async () => {
    const { event, restart } = buildEvent({ agent: { ...crashed, status: 'exited' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await POST(event as any)) as Response;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_crashed' });
    expect(restart).not.toHaveBeenCalled();
  });

  it('200 with mode on a successful restart', async () => {
    const { event, restart } = buildEvent({
      agent: crashed,
      restartResult: { ok: true, mode: 'resume', row: { id: 'agent-1' } }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await POST(event as any)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'resume', agentId: 'agent-1' });
    expect(restart).toHaveBeenCalledWith('agent-1');
  });

  it('409 with the supervisor error code (worktree_gone)', async () => {
    const { event } = buildEvent({
      agent: crashed,
      restartResult: { ok: false, code: 'worktree_gone' }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await POST(event as any)) as Response;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'worktree_gone' });
  });

  it('500 on launch_failed', async () => {
    const { event } = buildEvent({
      agent: crashed,
      restartResult: { ok: false, code: 'launch_failed', message: 'boom' }
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await POST(event as any)) as Response;
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'launch_failed', message: 'boom' });
  });
});
