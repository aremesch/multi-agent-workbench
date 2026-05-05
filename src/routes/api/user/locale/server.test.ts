import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const setUserSettingMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  setUserSetting: (...args: unknown[]) => setUserSettingMock(...args)
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
  const request = new Request('http://localhost/api/user/locale', {
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

beforeEach(() => {
  verifyCsrfMock.mockReset();
  setUserSettingMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

async function expectHttpError(
  res: Promise<unknown>,
  status: number
): Promise<void> {
  let caught: unknown = null;
  try {
    await res;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected handler to throw').not.toBeNull();
  expect((caught as { status?: number }).status).toBe(status);
}

describe('PUT /api/user/locale', () => {
  it('403 when CSRF verification fails', async () => {
    await expectHttpError(call({ csrfThrows: true, body: { locale: 'en' } }), 403);
  });

  it('401 when not signed in', async () => {
    await expectHttpError(call({ user: null, body: { locale: 'en' } }), 401);
  });

  it('400 when body is not valid JSON', async () => {
    await expectHttpError(call({ rawBody: 'not-json' }), 400);
  });

  it('400 when locale is missing', async () => {
    await expectHttpError(call({ body: {} }), 400);
  });

  it('400 when locale is unsupported', async () => {
    await expectHttpError(call({ body: { locale: 'pt-BR' } }), 400);
  });

  it('400 when locale is not a string', async () => {
    await expectHttpError(call({ body: { locale: 7 } }), 400);
  });

  it('204 and persists when locale is supported', async () => {
    const res = await call({ body: { locale: 'de' } });
    expect(res.status).toBe(204);
    expect(setUserSettingMock).toHaveBeenCalledWith('user-1', 'ui.locale', JSON.stringify('de'));
  });
});
