import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const insertProjectMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  insertProject: (...args: unknown[]) => insertProjectMock(...args)
}));

import { POST } from './+server.js';

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
  const request = new Request('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyStr
  });
  const event = {
    locals: {
      user: opts.user === undefined ? { id: 'user-1' } : opts.user,
      locale: 'en'
    },
    request,
    cookies: { get: () => undefined }
  };
  return POST(event as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  insertProjectMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

async function expectThrowStatus(res: Promise<unknown>, status: number): Promise<void> {
  let caught: unknown = null;
  try {
    await res;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected handler to throw').not.toBeNull();
  expect((caught as { status?: number }).status).toBe(status);
}

describe('POST /api/projects', () => {
  it('throws 403 when CSRF fails', async () => {
    await expectThrowStatus(call({ csrfThrows: true, body: { name: 'x' } }), 403);
  });

  it('401 when not signed in', async () => {
    const res = await call({ user: null, body: { name: 'x' } });
    expect(res.status).toBe(401);
    expect(insertProjectMock).not.toHaveBeenCalled();
  });

  it('400 when body is not valid JSON', async () => {
    const res = await call({ rawBody: 'not-json' });
    expect(res.status).toBe(400);
    expect(insertProjectMock).not.toHaveBeenCalled();
  });

  it('400 when name is missing', async () => {
    const res = await call({ body: {} });
    expect(res.status).toBe(400);
  });

  it('400 when name is whitespace only', async () => {
    const res = await call({ body: { name: '   ' } });
    expect(res.status).toBe(400);
  });

  it('400 when default_branch contains invalid chars', async () => {
    const res = await call({ body: { name: 'p', default_branch: 'bad branch!' } });
    expect(res.status).toBe(400);
  });

  it('200 with default_branch=main when not specified', async () => {
    const res = await call({ body: { name: 'My Project' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('My Project');
    expect(body.default_branch).toBe('main');
    expect(typeof body.id).toBe('string');
    expect(insertProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        name: 'My Project',
        default_branch: 'main'
      })
    );
  });

  it('200 with custom default_branch', async () => {
    const res = await call({ body: { name: 'P', default_branch: 'develop' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.default_branch).toBe('develop');
  });
});
