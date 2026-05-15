import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const getRoleMock = vi.fn();
const updateRoleMock = vi.fn();
const deleteRoleMock = vi.fn();
const countAgentsUsingRoleMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  getRole: (id: string) => getRoleMock(id),
  updateRole: (row: unknown) => updateRoleMock(row),
  deleteRole: (id: string, userId: string) => deleteRoleMock(id, userId),
  countAgentsUsingRole: (id: string) => countAgentsUsingRoleMock(id)
}));

import { GET, PUT, DELETE } from './+server.js';

interface CommonOpts {
  user?: { id: string } | null;
  id?: string;
  role?: { id: string; user_id: string; cli_kind: string; default_args_json: string; tool_config_json: string; repo_scope_json: string; system_prompt: string } | null;
  registryKinds?: string[];
  csrfThrows?: boolean;
}

function buildEvent(opts: CommonOpts, body?: unknown): unknown {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  if (opts.role !== undefined) {
    getRoleMock.mockReturnValueOnce(opts.role);
  }
  const kinds = opts.registryKinds ?? ['claude-code', 'shell'];
  return {
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
    params: { id: opts.id ?? 'role-1' },
    request:
      body !== undefined
        ? new Request('http://localhost/api/roles/x', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
        : undefined,
    cookies: { get: () => undefined }
  };
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  getRoleMock.mockReset();
  updateRoleMock.mockReset();
  deleteRoleMock.mockReset();
  countAgentsUsingRoleMock.mockReset();
});

const validRole = {
  id: 'role-1',
  user_id: 'user-1',
  cli_kind: 'shell',
  default_args_json: '{}',
  tool_config_json: '{}',
  repo_scope_json: '{}',
  system_prompt: 'be brief'
};

describe('GET /api/roles/:id', () => {
  it('401 when not signed in', async () => {
    const res = await GET(buildEvent({ user: null, role: validRole }) as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
  });

  it('404 when role not found', async () => {
    const res = await GET(buildEvent({ role: null }) as Parameters<typeof GET>[0]);
    expect(res.status).toBe(404);
  });

  it('404 when role belongs to another user (no leak)', async () => {
    const res = await GET(
      buildEvent({ role: { ...validRole, user_id: 'other' } }) as Parameters<typeof GET>[0]
    );
    expect(res.status).toBe(404);
  });

  it('200 returns the role', async () => {
    const res = await GET(buildEvent({ role: validRole }) as Parameters<typeof GET>[0]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'role-1' });
  });
});

describe('PUT /api/roles/:id', () => {
  it('404 when role not found', async () => {
    const res = await PUT(
      buildEvent({ role: null }, { name: 'x' }) as Parameters<typeof PUT>[0]
    );
    expect(res.status).toBe(404);
  });

  it('400 when name is missing', async () => {
    const res = await PUT(
      buildEvent({ role: validRole }, { name: '' }) as Parameters<typeof PUT>[0]
    );
    expect(res.status).toBe(400);
  });

  it('400 when cli_kind is unknown', async () => {
    const res = await PUT(
      buildEvent({ role: validRole, registryKinds: ['shell'] }, {
        name: 'r',
        cli_kind: 'not-real'
      }) as Parameters<typeof PUT>[0]
    );
    expect(res.status).toBe(400);
  });

  it('updates and returns the role on the happy path', async () => {
    updateRoleMock.mockReturnValueOnce(true);
    getRoleMock.mockReset();
    // Two calls to getRole: existence check (returns validRole) + return value after PUT (returns updated role).
    getRoleMock
      .mockReturnValueOnce(validRole)
      .mockReturnValueOnce({ ...validRole, name: 'Renamed' });
    const res = await PUT(
      buildEvent({ role: undefined }, { name: 'Renamed', cli_kind: 'shell' }) as Parameters<typeof PUT>[0]
    );
    expect(res.status).toBe(200);
    expect(updateRoleMock).toHaveBeenCalledTimes(1);
    const args = updateRoleMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.name).toBe('Renamed');
  });
});

describe('DELETE /api/roles/:id', () => {
  it('404 when role not found', async () => {
    const res = await DELETE(
      buildEvent({ role: null }) as Parameters<typeof DELETE>[0]
    );
    expect(res.status).toBe(404);
  });

  it('409 when agents still reference the role', async () => {
    countAgentsUsingRoleMock.mockReturnValueOnce(3);
    const res = await DELETE(
      buildEvent({ role: validRole }) as Parameters<typeof DELETE>[0]
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.count).toBe(3);
    expect(deleteRoleMock).not.toHaveBeenCalled();
  });

  it('200 on the happy path', async () => {
    countAgentsUsingRoleMock.mockReturnValueOnce(0);
    deleteRoleMock.mockReturnValueOnce(true);
    const res = await DELETE(
      buildEvent({ role: validRole }) as Parameters<typeof DELETE>[0]
    );
    expect(res.status).toBe(200);
    expect(deleteRoleMock).toHaveBeenCalledWith('role-1', 'user-1');
  });
});
