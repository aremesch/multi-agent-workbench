import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const getRepoMock = vi.fn();
const getProjectMock = vi.fn();
const updateRepoMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  getRepo: (id: string) => getRepoMock(id),
  getProject: (id: string) => getProjectMock(id),
  updateRepo: (...args: unknown[]) => updateRepoMock(...args)
}));

import { GET, PUT } from './+server.js';

function makeEvent(opts: {
  user?: { id: string } | null;
  id?: string;
  request?: Request;
  csrfThrows?: boolean;
}) {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  return {
    locals: {
      user: opts.user === undefined ? { id: 'user-1' } : opts.user,
      locale: 'en'
    },
    params: { id: opts.id ?? 'repo-1' },
    request: opts.request,
    cookies: { get: () => undefined }
  };
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  getRepoMock.mockReset();
  getProjectMock.mockReset();
  updateRepoMock.mockReset();
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

describe('GET /api/repos/[id]', () => {
  it('401 when not signed in', async () => {
    const res = await GET(
      makeEvent({ user: null }) as unknown as Parameters<typeof GET>[0]
    );
    expect(res.status).toBe(401);
  });

  it('404 when repo does not exist', async () => {
    getRepoMock.mockReturnValue(undefined);
    const res = await GET(makeEvent({}) as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(404);
  });

  it('404 when repo belongs to another user', async () => {
    getRepoMock.mockReturnValue({
      id: 'repo-1',
      user_id: 'other-user',
      path: '/r',
      origin_url: null,
      default_branch: 'main',
      project_id: null
    });
    const res = await GET(makeEvent({}) as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(404);
  });

  it('200 with project name when project_id is set and project resolves', async () => {
    getRepoMock.mockReturnValue({
      id: 'repo-1',
      user_id: 'user-1',
      path: '/r',
      origin_url: 'git@x:y.git',
      default_branch: 'main',
      project_id: 'proj-1'
    });
    getProjectMock.mockReturnValue({ id: 'proj-1', name: 'My Project' });
    const res = await GET(makeEvent({}) as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: 'repo-1',
      path: '/r',
      origin_url: 'git@x:y.git',
      default_branch: 'main',
      projectName: 'My Project'
    });
  });

  it('200 with basename(path) when project_id is null', async () => {
    getRepoMock.mockReturnValue({
      id: 'repo-1',
      user_id: 'user-1',
      path: '/some/dir/myrepo',
      origin_url: null,
      default_branch: 'main',
      project_id: null
    });
    const res = await GET(makeEvent({}) as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectName).toBe('myrepo');
    expect(getProjectMock).not.toHaveBeenCalled();
  });

  it('200 with basename fallback when project lookup returns null', async () => {
    getRepoMock.mockReturnValue({
      id: 'repo-1',
      user_id: 'user-1',
      path: '/x/y',
      origin_url: null,
      default_branch: 'main',
      project_id: 'proj-x'
    });
    getProjectMock.mockReturnValue(undefined);
    const res = await GET(makeEvent({}) as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectName).toBe('y');
  });
});

describe('PUT /api/repos/[id]', () => {
  function putEvent(opts: {
    user?: { id: string } | null;
    body?: unknown;
    rawBody?: string;
    csrfThrows?: boolean;
  }) {
    const bodyStr =
      opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
    return makeEvent({
      user: opts.user,
      csrfThrows: opts.csrfThrows,
      request: new Request('http://localhost/api/repos/repo-1', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: bodyStr
      })
    });
  }

  it('throws 403 when CSRF fails', async () => {
    await expectThrowStatus(
      PUT(
        putEvent({ csrfThrows: true, body: { origin_url: 'x' } }) as unknown as Parameters<
          typeof PUT
        >[0]
      ),
      403
    );
  });

  it('401 when not signed in', async () => {
    const res = await PUT(
      putEvent({ user: null, body: { origin_url: 'x' } }) as unknown as Parameters<
        typeof PUT
      >[0]
    );
    expect(res.status).toBe(401);
  });

  it('400 when body is not valid JSON', async () => {
    const res = await PUT(
      putEvent({ rawBody: 'oops' }) as unknown as Parameters<typeof PUT>[0]
    );
    expect(res.status).toBe(400);
  });

  it('404 when updateRepo returns false (foreign user)', async () => {
    updateRepoMock.mockReturnValue(false);
    const res = await PUT(
      putEvent({ body: { origin_url: 'x' } }) as unknown as Parameters<typeof PUT>[0]
    );
    expect(res.status).toBe(404);
  });

  it('200 and forwards owner-scoped origin_url to updateRepo', async () => {
    updateRepoMock.mockReturnValue(true);
    const res = await PUT(
      putEvent({ body: { origin_url: ' git@x:y.git ' } }) as unknown as Parameters<
        typeof PUT
      >[0]
    );
    expect(res.status).toBe(200);
    expect(updateRepoMock).toHaveBeenCalledWith({
      id: 'repo-1',
      user_id: 'user-1',
      origin_url: 'git@x:y.git'
    });
  });

  it('treats empty origin_url as null (clears the field)', async () => {
    updateRepoMock.mockReturnValue(true);
    const res = await PUT(
      putEvent({ body: { origin_url: '   ' } }) as unknown as Parameters<typeof PUT>[0]
    );
    expect(res.status).toBe(200);
    const args = updateRepoMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.origin_url).toBeNull();
  });

  it('treats null origin_url as null', async () => {
    updateRepoMock.mockReturnValue(true);
    const res = await PUT(
      putEvent({ body: { origin_url: null } }) as unknown as Parameters<typeof PUT>[0]
    );
    expect(res.status).toBe(200);
    const args = updateRepoMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.origin_url).toBeNull();
  });
});
