import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const deletePushSubByEndpointMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  deletePushSubByEndpoint: (endpoint: string) => deletePushSubByEndpointMock(endpoint)
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
  const request = new Request('http://localhost/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyStr
  });
  const event = {
    locals: { user: opts.user === undefined ? { id: 'user-1' } : opts.user },
    request,
    cookies: { get: () => undefined }
  };
  return POST(event as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  deletePushSubByEndpointMock.mockReset();
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

describe('POST /api/push/unsubscribe', () => {
  it('throws 403 when CSRF fails', async () => {
    await expectThrowStatus(
      call({ csrfThrows: true, body: { endpoint: 'https://x.example/y' } }),
      403
    );
  });

  it('throws 401 when not signed in', async () => {
    await expectThrowStatus(
      call({ user: null, body: { endpoint: 'https://x.example/y' } }),
      401
    );
  });

  it('throws 400 when body is not valid JSON', async () => {
    await expectThrowStatus(call({ rawBody: 'oops' }), 400);
  });

  it('throws 400 when endpoint is not a URL', async () => {
    await expectThrowStatus(call({ body: { endpoint: 'not a url' } }), 400);
  });

  it('throws 400 when endpoint is missing', async () => {
    await expectThrowStatus(call({ body: {} }), 400);
  });

  it('204 and forwards endpoint to deletePushSubByEndpoint', async () => {
    const res = await call({ body: { endpoint: 'https://fcm.googleapis.com/x' } });
    expect(res.status).toBe(204);
    expect(deletePushSubByEndpointMock).toHaveBeenCalledWith(
      'https://fcm.googleapis.com/x'
    );
  });
});
