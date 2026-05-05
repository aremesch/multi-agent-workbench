import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const setUserSettingMock = vi.fn();
const getUserSettingMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  setUserSetting: (...args: unknown[]) => setUserSettingMock(...args),
  getUserSetting: (...args: unknown[]) => getUserSettingMock(...args)
}));

import { GET, PUT } from './+server.js';

interface PutOpts {
  user?: { id: string } | null;
  body?: unknown;
  rawBody?: string;
  csrfThrows?: boolean;
}

async function callPut(opts: PutOpts = {}): Promise<Response> {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  const bodyStr =
    opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  const request = new Request('http://localhost/api/user/dashboard-layout', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: bodyStr
  });
  const event = {
    locals: { user: opts.user === undefined ? { id: 'user-1' } : opts.user },
    request,
    cookies: { get: () => undefined }
  };
  return PUT(event as unknown as Parameters<typeof PUT>[0]);
}

interface GetOpts {
  user?: { id: string } | null;
  key?: string | null;
}

async function callGet(opts: GetOpts = {}): Promise<Response> {
  const url = new URL('http://localhost/api/user/dashboard-layout');
  if (opts.key !== undefined && opts.key !== null) url.searchParams.set('key', opts.key);
  const event = {
    locals: { user: opts.user === undefined ? { id: 'user-1' } : opts.user },
    url
  };
  return GET(event as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  setUserSettingMock.mockReset();
  getUserSettingMock.mockReset();
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

const validLayout = [{ agentId: 'a1', x: 0, y: 0, w: 1, h: 1 }];

describe('GET /api/user/dashboard-layout', () => {
  it('401 when not signed in', async () => {
    await expectHttpError(callGet({ user: null }), 401);
  });

  it('400 when an invalid layout key is requested', async () => {
    await expectHttpError(callGet({ key: 'not.a.real.key' }), 400);
  });

  it('returns layout=null when nothing is stored', async () => {
    getUserSettingMock.mockReturnValue(null);
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ layout: null });
  });

  it('returns layout=null when stored row is corrupt JSON', async () => {
    getUserSettingMock.mockReturnValue('not-json');
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ layout: null });
  });

  it('returns layout=null when stored shape is bogus', async () => {
    getUserSettingMock.mockReturnValue(JSON.stringify({ layout: [{ x: 1 }] }));
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ layout: null });
  });

  it('returns the parsed layout array on success', async () => {
    getUserSettingMock.mockReturnValue(JSON.stringify({ layout: validLayout }));
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ layout: validLayout });
  });
});

describe('PUT /api/user/dashboard-layout', () => {
  it('403 when CSRF fails', async () => {
    await expectHttpError(callPut({ csrfThrows: true, body: { layout: validLayout } }), 403);
  });

  it('401 when not signed in', async () => {
    await expectHttpError(callPut({ user: null, body: { layout: validLayout } }), 401);
  });

  it('400 when body is not valid JSON', async () => {
    await expectHttpError(callPut({ rawBody: '{' }), 400);
  });

  it('400 when layout shape is invalid', async () => {
    await expectHttpError(callPut({ body: { layout: [{ x: 1 }] } }), 400);
  });

  it('400 when key is invalid', async () => {
    await expectHttpError(
      callPut({ body: { key: 'bogus.key', layout: validLayout } }),
      400
    );
  });

  it('204 and persists under the default key when key omitted', async () => {
    const res = await callPut({ body: { layout: validLayout } });
    expect(res.status).toBe(204);
    expect(setUserSettingMock).toHaveBeenCalledWith(
      'user-1',
      'dashboard.layout.v3',
      JSON.stringify({ layout: validLayout })
    );
  });
});
