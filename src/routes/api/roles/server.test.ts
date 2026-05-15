import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const insertRoleMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  insertRole: (...args: unknown[]) => insertRoleMock(...args)
}));

import { POST } from './+server.js';

interface CallOpts {
  user?: { id: string } | null;
  body?: unknown;
  rawBody?: string;
  csrfThrows?: boolean;
  registryKinds?: string[];
}

async function call(opts: CallOpts = {}): Promise<Response> {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  const bodyStr =
    opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  const request = new Request('http://localhost/api/roles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyStr
  });
  const kinds = opts.registryKinds ?? ['claude-code', 'codex', 'gemini', 'shell'];
  const event = {
    locals: {
      user: opts.user === undefined ? { id: 'user-1' } : opts.user,
      locale: 'en',
      supervisor: {
        registry: {
          list: () =>
            kinds.map((k) => ({
              kind: k,
              capabilities: { model: null, permissionMode: null }
            }))
        }
      }
    },
    request,
    cookies: { get: () => undefined }
  };
  return POST(event as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  insertRoleMock.mockReset();
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

describe('POST /api/roles', () => {
  it('throws 403 when CSRF fails', async () => {
    await expectThrowStatus(
      call({ csrfThrows: true, body: { name: 'x', cli_kind: 'claude-code' } }),
      403
    );
  });

  it('401 when not signed in', async () => {
    const res = await call({ user: null, body: { name: 'x', cli_kind: 'claude-code' } });
    expect(res.status).toBe(401);
  });

  it('400 when body is not valid JSON', async () => {
    const res = await call({ rawBody: '{' });
    expect(res.status).toBe(400);
  });

  it('400 when name is missing', async () => {
    const res = await call({ body: { cli_kind: 'claude-code' } });
    expect(res.status).toBe(400);
  });

  it('400 when cli_kind is unknown to the registry', async () => {
    const res = await call({
      body: { name: 'r', cli_kind: 'fake-cli' },
      registryKinds: ['claude-code']
    });
    expect(res.status).toBe(400);
  });

  it('400 when cli_kind is empty', async () => {
    const res = await call({ body: { name: 'r', cli_kind: '' } });
    expect(res.status).toBe(400);
  });

  it('200 and inserts the role on the happy path', async () => {
    const res = await call({
      body: { name: 'My Role', cli_kind: 'shell', system_prompt: 'be brief' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: 'My Role', cli_kind: 'shell' });
    expect(typeof body.id).toBe('string');
    expect(insertRoleMock).toHaveBeenCalledTimes(1);
    const args = insertRoleMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.user_id).toBe('user-1');
    expect(args.name).toBe('My Role');
    expect(args.cli_kind).toBe('shell');
    expect(args.system_prompt).toBe('be brief');
  });

  it('defaults system_prompt to empty string when omitted', async () => {
    const res = await call({ body: { name: 'r', cli_kind: 'shell' } });
    expect(res.status).toBe(200);
    const args = insertRoleMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.system_prompt).toBe('');
  });
});
