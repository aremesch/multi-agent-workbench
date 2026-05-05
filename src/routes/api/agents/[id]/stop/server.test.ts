import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const getAgentMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  getAgent: (id: string) => getAgentMock(id)
}));

import { POST } from './+server.js';

interface CallOpts {
  user?: { id: string } | null;
  csrfThrows?: boolean;
  killImpl?: () => Promise<void>;
}

const killMock = vi.fn();

async function call(opts: CallOpts = {}): Promise<Response> {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  if (opts.killImpl) {
    killMock.mockImplementationOnce(opts.killImpl);
  }
  const event = {
    locals: {
      user: opts.user === undefined ? { id: 'user-1' } : opts.user,
      supervisor: { kill: killMock }
    },
    params: { id: 'agent-1' },
    request: new Request('http://localhost/api/agents/agent-1/stop', { method: 'POST' }),
    cookies: { get: () => undefined }
  };
  return POST(event as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  getAgentMock.mockReset();
  killMock.mockReset();
  killMock.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
});

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

describe('POST /api/agents/:id/stop', () => {
  it('throws 403 when CSRF fails', async () => {
    await expectHttpError(call({ csrfThrows: true }), 403);
  });

  it('401 when not signed in', async () => {
    await expectHttpError(call({ user: null }), 401);
  });

  it('404 when agent does not exist', async () => {
    getAgentMock.mockReturnValue(undefined);
    await expectHttpError(call(), 404);
  });

  it('403 when agent belongs to another user', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'other', status: 'running' });
    await expectHttpError(call(), 403);
  });

  it('409 when agent is already exited', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1', status: 'exited' });
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('already_archived');
    expect(body.status).toBe('exited');
    expect(killMock).not.toHaveBeenCalled();
  });

  it('409 when agent is already crashed', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1', status: 'crashed' });
    const res = await call();
    expect(res.status).toBe(409);
  });

  it('500 when supervisor.kill throws', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1', status: 'running' });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call({
      killImpl: async () => {
        throw new Error('boom');
      }
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('kill_failed');
    expect(body.error).toBe('boom');
    consoleErrorSpy.mockRestore();
  });

  it('200 with status=exited on happy path', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1', status: 'running' });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'exited' });
    expect(killMock).toHaveBeenCalledWith('agent-1');
  });
});
