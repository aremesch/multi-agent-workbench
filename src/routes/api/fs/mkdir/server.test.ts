import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const getFsBrowseRootMock = vi.fn();
const createDirectoryMock = vi.fn();

const { BrowseError } = vi.hoisted(() => {
  class BrowseError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return { BrowseError };
});

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/config', () => ({
  getFsBrowseRoot: () => getFsBrowseRootMock()
}));

vi.mock('$lib/server/fs/browse', () => ({
  BrowseError,
  createDirectory: (...args: unknown[]) => createDirectoryMock(...args)
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
  const request = new Request('http://localhost/api/fs/mkdir', {
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
  getFsBrowseRootMock.mockReset();
  getFsBrowseRootMock.mockReturnValue('/home/alice');
  createDirectoryMock.mockReset();
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

describe('POST /api/fs/mkdir', () => {
  it('throws 403 when CSRF fails', async () => {
    await expectThrowStatus(
      call({ csrfThrows: true, body: { parent: '/home/alice', name: 'x' } }),
      403
    );
  });

  it('401 when not signed in', async () => {
    const res = await call({ user: null, body: { parent: '/x', name: 'y' } });
    expect(res.status).toBe(401);
  });

  it('400 when body is not valid JSON', async () => {
    const res = await call({ rawBody: 'no' });
    expect(res.status).toBe(400);
  });

  it('400 when parent is missing', async () => {
    const res = await call({ body: { name: 'x' } });
    expect(res.status).toBe(400);
  });

  it('200 happy path returns the realpath', async () => {
    createDirectoryMock.mockReturnValue('/home/alice/code/x');
    const res = await call({ body: { parent: '/home/alice/code', name: 'x' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: '/home/alice/code/x' });
    expect(createDirectoryMock).toHaveBeenCalledWith(
      '/home/alice/code',
      'x',
      '/home/alice'
    );
  });

  it.each([
    ['outside_root', 403],
    ['not_found', 404],
    ['not_directory', 400],
    ['invalid_name', 400],
    ['already_exists', 409],
    ['mkdir_failed', 500],
    ['read_failed', 500]
  ])('maps BrowseError(%s) → %d', async (code, status) => {
    createDirectoryMock.mockImplementation(() => {
      throw new BrowseError(code, 'm');
    });
    const res = await call({ body: { parent: '/home/alice', name: 'x' } });
    expect(res.status).toBe(status);
  });

  it('500 when createDirectory throws an unexpected error', async () => {
    createDirectoryMock.mockImplementation(() => {
      throw new Error('weird');
    });
    const res = await call({ body: { parent: '/home/alice', name: 'x' } });
    expect(res.status).toBe(500);
  });
});
