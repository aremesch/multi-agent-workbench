import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const getRepoMock = vi.fn();
const updateRepoMock = vi.fn();
const deleteRepoMock = vi.fn();
const countAgentsForRepoMock = vi.fn();
const countOpenQueueEntriesForRepoMock = vi.fn();
const listWorktreesForRepoMock = vi.fn();
const worktreeRemoveMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  getRepo: (id: string) => getRepoMock(id),
  updateRepo: (...args: unknown[]) => updateRepoMock(...args),
  deleteRepo: (...args: unknown[]) => deleteRepoMock(...args),
  countAgentsForRepo: (...args: unknown[]) => countAgentsForRepoMock(...args),
  countOpenQueueEntriesForRepo: (...args: unknown[]) =>
    countOpenQueueEntriesForRepoMock(...args),
  listWorktreesForRepo: (...args: unknown[]) => listWorktreesForRepoMock(...args)
}));

vi.mock('$lib/server/git/WorktreeManager', () => ({
  WorktreeManager: class {
    remove(...args: unknown[]) {
      return worktreeRemoveMock(...args);
    }
  }
}));

vi.mock('$lib/server/config', () => ({
  getConfig: () => ({ worktreeRoot: '/wt' })
}));

import { DELETE, GET, PUT } from './+server.js';

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
  updateRepoMock.mockReset();
  deleteRepoMock.mockReset();
  countAgentsForRepoMock.mockReset();
  countOpenQueueEntriesForRepoMock.mockReset();
  listWorktreesForRepoMock.mockReset();
  worktreeRemoveMock.mockReset();
  countAgentsForRepoMock.mockReturnValue(0);
  countOpenQueueEntriesForRepoMock.mockReturnValue(0);
  listWorktreesForRepoMock.mockReturnValue([]);
  worktreeRemoveMock.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
});

async function expectThrowStatus(
  res: Promise<unknown> | unknown,
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
      default_branch: 'main'
    });
    const res = await GET(makeEvent({}) as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(404);
  });

  it('200 returns repo with projectName = basename(path)', async () => {
    getRepoMock.mockReturnValue({
      id: 'repo-1',
      user_id: 'user-1',
      path: '/some/dir/myrepo',
      origin_url: 'git@x:y.git',
      default_branch: 'main'
    });
    const res = await GET(makeEvent({}) as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: 'repo-1',
      path: '/some/dir/myrepo',
      origin_url: 'git@x:y.git',
      default_branch: 'main',
      projectName: 'myrepo'
    });
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

describe('DELETE /api/repos/[id]', () => {
  const ownedRepo = {
    id: 'repo-1',
    user_id: 'user-1',
    path: '/some/dir/myrepo',
    origin_url: null,
    default_branch: 'main'
  };

  function delEvent(opts: { user?: { id: string } | null; csrfThrows?: boolean } = {}) {
    return makeEvent({
      user: opts.user,
      csrfThrows: opts.csrfThrows,
      request: new Request('http://localhost/api/repos/repo-1', { method: 'DELETE' })
    });
  }

  it('throws 403 when CSRF fails', async () => {
    await expectThrowStatus(
      DELETE(delEvent({ csrfThrows: true }) as unknown as Parameters<typeof DELETE>[0]),
      403
    );
  });

  it('401 when not signed in', async () => {
    const res = await DELETE(
      delEvent({ user: null }) as unknown as Parameters<typeof DELETE>[0]
    );
    expect(res.status).toBe(401);
  });

  it('404 when repo does not exist', async () => {
    getRepoMock.mockReturnValue(undefined);
    const res = await DELETE(delEvent() as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(404);
    expect(deleteRepoMock).not.toHaveBeenCalled();
  });

  it('404 when repo belongs to another user', async () => {
    getRepoMock.mockReturnValue({ ...ownedRepo, user_id: 'other-user' });
    const res = await DELETE(delEvent() as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(404);
    expect(deleteRepoMock).not.toHaveBeenCalled();
  });

  it('409 repo_in_use when the repo has agents', async () => {
    getRepoMock.mockReturnValue(ownedRepo);
    countAgentsForRepoMock.mockReturnValue(2);
    const res = await DELETE(delEvent() as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ code: 'repo_in_use', agents: 2, openTasks: 0 });
    expect(deleteRepoMock).not.toHaveBeenCalled();
  });

  it('409 repo_in_use when the repo has open queue entries', async () => {
    getRepoMock.mockReturnValue(ownedRepo);
    countOpenQueueEntriesForRepoMock.mockReturnValue(3);
    const res = await DELETE(delEvent() as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ code: 'repo_in_use', agents: 0, openTasks: 3 });
    expect(deleteRepoMock).not.toHaveBeenCalled();
  });

  it('204 and removes on-disk worktrees for a fully-empty repo', async () => {
    getRepoMock.mockReturnValue(ownedRepo);
    listWorktreesForRepoMock.mockReturnValue([
      { id: 'wt-1', path: '/wt/a', status: 'active' },
      { id: 'wt-2', path: '/wt/b', status: 'removed' }, // tombstone — skipped
      { id: 'wt-3', path: ownedRepo.path, status: 'active' } // shares repo root — skipped
    ]);
    deleteRepoMock.mockReturnValue(true);
    const res = await DELETE(delEvent() as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(204);
    expect(worktreeRemoveMock).toHaveBeenCalledTimes(1);
    expect(worktreeRemoveMock).toHaveBeenCalledWith({
      repoPath: ownedRepo.path,
      wtPath: '/wt/a',
      force: true
    });
    expect(deleteRepoMock).toHaveBeenCalledWith('repo-1', 'user-1');
  });

  it('still deletes the repo row when a worktree removal fails', async () => {
    getRepoMock.mockReturnValue(ownedRepo);
    listWorktreesForRepoMock.mockReturnValue([
      { id: 'wt-1', path: '/wt/a', status: 'active' }
    ]);
    worktreeRemoveMock.mockRejectedValue(new Error('disk gone'));
    deleteRepoMock.mockReturnValue(true);
    const res = await DELETE(delEvent() as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(204);
    expect(deleteRepoMock).toHaveBeenCalledWith('repo-1', 'user-1');
  });

  it('404 when deleteRepo returns false', async () => {
    getRepoMock.mockReturnValue(ownedRepo);
    deleteRepoMock.mockReturnValue(false);
    const res = await DELETE(delEvent() as unknown as Parameters<typeof DELETE>[0]);
    expect(res.status).toBe(404);
  });
});
