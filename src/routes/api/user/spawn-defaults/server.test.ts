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

/** Stub registry with one fully-featured adapter (claude-code) so the
 *  handler can validate capability-value ids without hitting the real
 *  AdapterRegistry singleton. */
function makeRegistry() {
  return {
    list: () => [
      {
        kind: 'claude-code',
        capabilities: {
          model: {
            label: 'Model',
            default: 'default',
            values: [
              { id: 'default', label: 'Default' },
              { id: 'opus', label: 'Opus' },
              { id: 'sonnet', label: 'Sonnet' }
            ]
          },
          permissionMode: {
            label: 'Permission mode',
            default: 'plan',
            values: [
              { id: 'plan', label: 'Plan' },
              { id: 'default', label: 'Default (ask)' }
            ]
          }
        }
      }
    ]
  };
}

async function call(opts: CallOpts = {}): Promise<Response> {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  const bodyStr =
    opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  const request = new Request('http://localhost/api/user/spawn-defaults', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: bodyStr
  });
  const event = {
    locals: {
      user: opts.user === undefined ? { id: 'user-1' } : opts.user,
      supervisor: { registry: makeRegistry() }
    },
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

describe('PUT /api/user/spawn-defaults', () => {
  it('403 when CSRF verification fails', async () => {
    await expectHttpError(
      call({
        csrfThrows: true,
        body: { cliKind: 'claude-code', optionalArgs: { foo: true } }
      }),
      403
    );
  });

  it('401 when not signed in', async () => {
    await expectHttpError(
      call({ user: null, body: { cliKind: 'claude-code', optionalArgs: {} } }),
      401
    );
  });

  it('400 when body is not valid JSON', async () => {
    await expectHttpError(call({ rawBody: 'no' }), 400);
  });

  it('400 when cliKind is missing', async () => {
    await expectHttpError(call({ body: { optionalArgs: {} } }), 400);
  });

  it('400 when cliKind is not a string', async () => {
    await expectHttpError(call({ body: { cliKind: 9, optionalArgs: {} } }), 400);
  });

  it('400 when optionalArgs is missing', async () => {
    await expectHttpError(call({ body: { cliKind: 'claude-code' } }), 400);
  });

  it('400 when optionalArgs is not an object', async () => {
    await expectHttpError(
      call({ body: { cliKind: 'claude-code', optionalArgs: 'yes' } }),
      400
    );
  });

  it('400 when optionalArgs contains a non-boolean value', async () => {
    await expectHttpError(
      call({ body: { cliKind: 'claude-code', optionalArgs: { skip: 1 } } }),
      400
    );
  });

  it('400 when cliKind is unknown', async () => {
    await expectHttpError(
      call({ body: { cliKind: 'unknown', optionalArgs: {} } }),
      400
    );
  });

  it('400 when defaultModel is not in the adapter values list', async () => {
    await expectHttpError(
      call({
        body: {
          cliKind: 'claude-code',
          optionalArgs: {},
          defaultModel: 'gpt-99'
        }
      }),
      400
    );
  });

  it('400 when defaultPermissionMode is not in the adapter values list', async () => {
    await expectHttpError(
      call({
        body: {
          cliKind: 'claude-code',
          optionalArgs: {},
          defaultPermissionMode: 'wild-west'
        }
      }),
      400
    );
  });

  it('204 and persists under spawn.defaults.<cliKind> with null defaults when unset', async () => {
    const res = await call({
      body: { cliKind: 'claude-code', optionalArgs: { skip: true, retry: false } }
    });
    expect(res.status).toBe(204);
    expect(setUserSettingMock).toHaveBeenCalledWith(
      'user-1',
      'spawn.defaults.claude-code',
      JSON.stringify({
        optionalArgs: { skip: true, retry: false },
        defaultModel: null,
        defaultPermissionMode: null
      })
    );
  });

  it('204 and persists validated defaultModel + defaultPermissionMode', async () => {
    const res = await call({
      body: {
        cliKind: 'claude-code',
        optionalArgs: {},
        defaultModel: 'opus',
        defaultPermissionMode: 'plan'
      }
    });
    expect(res.status).toBe(204);
    expect(setUserSettingMock).toHaveBeenCalledWith(
      'user-1',
      'spawn.defaults.claude-code',
      JSON.stringify({
        optionalArgs: {},
        defaultModel: 'opus',
        defaultPermissionMode: 'plan'
      })
    );
  });

  it('204 and clears defaults when explicitly null', async () => {
    const res = await call({
      body: {
        cliKind: 'claude-code',
        optionalArgs: {},
        defaultModel: null,
        defaultPermissionMode: null
      }
    });
    expect(res.status).toBe(204);
    expect(setUserSettingMock).toHaveBeenCalledWith(
      'user-1',
      'spawn.defaults.claude-code',
      JSON.stringify({
        optionalArgs: {},
        defaultModel: null,
        defaultPermissionMode: null
      })
    );
  });
});
