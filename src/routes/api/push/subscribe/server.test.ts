import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const upsertPushSubMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  upsertPushSub: (...args: unknown[]) => upsertPushSubMock(...args)
}));

import { POST } from './+server.js';

interface CallOpts {
  user?: { id: string } | null;
  body?: unknown;
  rawBody?: string;
  csrfThrows?: boolean;
  ua?: string;
}

async function call(opts: CallOpts = {}): Promise<Response> {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  const bodyStr =
    opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.ua) headers['user-agent'] = opts.ua;
  const request = new Request('http://localhost/api/push/subscribe', {
    method: 'POST',
    headers,
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
  upsertPushSubMock.mockReset();
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

const validBody = {
  endpoint: 'https://fcm.googleapis.com/x',
  keys: { p256dh: 'aaaa', auth: 'bbbb' }
};

describe('POST /api/push/subscribe', () => {
  it('throws 403 when CSRF fails', async () => {
    await expectThrowStatus(call({ csrfThrows: true, body: validBody }), 403);
  });

  it('throws 401 when not signed in', async () => {
    await expectThrowStatus(call({ user: null, body: validBody }), 401);
  });

  it('throws 400 when body is not valid JSON', async () => {
    await expectThrowStatus(call({ rawBody: '{' }), 400);
  });

  it('throws 400 when endpoint is not a URL', async () => {
    await expectThrowStatus(
      call({ body: { endpoint: 'not a url', keys: { p256dh: 'a', auth: 'b' } } }),
      400
    );
  });

  it('throws 400 when keys are missing', async () => {
    await expectThrowStatus(
      call({ body: { endpoint: 'https://x.example/y' } }),
      400
    );
  });

  it('throws 400 when keys.p256dh is empty', async () => {
    await expectThrowStatus(
      call({
        body: { endpoint: 'https://x.example/y', keys: { p256dh: '', auth: 'b' } }
      }),
      400
    );
  });

  it('201 and forwards user_id, endpoint, keys, ua to upsertPushSub', async () => {
    const res = await call({ body: validBody, ua: 'TestAgent/1.0' });
    expect(res.status).toBe(201);
    expect(upsertPushSubMock).toHaveBeenCalledTimes(1);
    const arg = upsertPushSubMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.user_id).toBe('user-1');
    expect(arg.endpoint).toBe(validBody.endpoint);
    expect(arg.p256dh).toBe('aaaa');
    expect(arg.auth).toBe('bbbb');
    expect(arg.ua).toBe('TestAgent/1.0');
    expect(typeof arg.id).toBe('string');
  });

  it('persists ua=null when no User-Agent header is sent', async () => {
    const res = await call({ body: validBody });
    expect(res.status).toBe(201);
    const arg = upsertPushSubMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.ua).toBeNull();
  });
});
