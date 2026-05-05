import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const getAgentMock = vi.fn();
const updateAgentTargetMock = vi.fn();
const isBrowserKindMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  getAgent: (id: string) => getAgentMock(id),
  updateAgentTarget: (...args: unknown[]) => updateAgentTargetMock(...args)
}));

vi.mock('$lib/server/agents/AgentSupervisor', () => ({
  isBrowserKind: (k: string) => isBrowserKindMock(k)
}));

import { PUT } from './+server.js';

interface CallOpts {
  user?: { id: string } | null;
  body?: unknown;
  rawBody?: string;
  csrfThrows?: boolean;
}

async function call(opts: CallOpts = {}): Promise<Response> {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  const bodyStr =
    opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  const request = new Request('http://localhost/api/agents/agent-1/target', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: bodyStr
  });
  const event = {
    locals: { user: opts.user === undefined ? { id: 'user-1' } : opts.user },
    params: { id: 'agent-1' },
    request,
    cookies: { get: () => undefined }
  };
  return PUT(event as unknown as Parameters<typeof PUT>[0]);
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  getAgentMock.mockReset();
  updateAgentTargetMock.mockReset();
  isBrowserKindMock.mockReset();
  isBrowserKindMock.mockReturnValue(true);
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

const browserAgent = {
  id: 'agent-1',
  user_id: 'user-1',
  cli_kind: 'browser',
  status: 'running'
};

describe('PUT /api/agents/:id/target', () => {
  it('throws 403 when CSRF fails', async () => {
    await expectHttpError(
      call({ csrfThrows: true, body: { target_url: 'http://localhost:5173' } }),
      403
    );
  });

  it('401 when not signed in', async () => {
    await expectHttpError(call({ user: null, body: {} }), 401);
  });

  it('404 when agent does not exist', async () => {
    getAgentMock.mockReturnValue(undefined);
    await expectHttpError(call({ body: {} }), 404);
  });

  it('403 when agent belongs to another user', async () => {
    getAgentMock.mockReturnValue({ ...browserAgent, user_id: 'other' });
    await expectHttpError(call({ body: {} }), 403);
  });

  it('409 not_browser_agent when cli_kind is not a browser kind', async () => {
    isBrowserKindMock.mockReturnValue(false);
    getAgentMock.mockReturnValue({ ...browserAgent, cli_kind: 'shell' });
    const res = await call({ body: { target_url: 'http://localhost:5173' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'not_browser_agent' });
  });

  it('409 archived when status is exited', async () => {
    getAgentMock.mockReturnValue({ ...browserAgent, status: 'exited' });
    const res = await call({ body: { target_url: 'http://localhost:5173' } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('archived');
    expect(body.status).toBe('exited');
  });

  it('400 invalid_url_empty when target_url is missing', async () => {
    getAgentMock.mockReturnValue(browserAgent);
    const res = await call({ body: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'invalid_url_empty' });
  });

  it('400 invalid_url_invalid when target_url is unparseable', async () => {
    getAgentMock.mockReturnValue(browserAgent);
    const res = await call({ body: { target_url: 'not a url' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_url_invalid');
  });

  it('400 invalid_url_scheme when scheme is https', async () => {
    getAgentMock.mockReturnValue(browserAgent);
    const res = await call({ body: { target_url: 'https://localhost:5173' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_url_scheme');
  });

  it('400 invalid_url_host when host is not localhost/127.0.0.1', async () => {
    getAgentMock.mockReturnValue(browserAgent);
    const res = await call({ body: { target_url: 'http://example.com:5173' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_url_host');
  });

  it('400 invalid_url_port when port is missing', async () => {
    getAgentMock.mockReturnValue(browserAgent);
    const res = await call({ body: { target_url: 'http://localhost' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_url_port');
  });

  it('404 when updateAgentTarget reports no rows changed', async () => {
    getAgentMock.mockReturnValue(browserAgent);
    updateAgentTargetMock.mockReturnValue(0);
    await expectHttpError(
      call({ body: { target_url: 'http://localhost:5173' } }),
      404
    );
  });

  it('200 happy path with canonical URL and parsed port', async () => {
    getAgentMock.mockReturnValue(browserAgent);
    updateAgentTargetMock.mockReturnValue(1);
    const res = await call({
      body: { target_url: 'http://localhost:5173/some/path?q=1#x' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_url).toBe('http://localhost:5173');
    expect(body.target_port).toBe(5173);
    expect(updateAgentTargetMock).toHaveBeenCalledWith(
      'agent-1',
      'user-1',
      'http://localhost:5173',
      5173
    );
  });
});
