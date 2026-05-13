import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const getProjectMock = vi.fn();
const insertRepoMock = vi.fn();
const cloneIntoMock = vi.fn();
const ensureDefaultBranchMock = vi.fn();
const initEmptyMock = vi.fn();
const resolveGitIdentityMock = vi.fn();
const revparseMock = vi.fn();
const getGitMock = vi.fn();

const existsSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const statSyncMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  getProject: (id: string) => getProjectMock(id),
  insertRepo: (...args: unknown[]) => insertRepoMock(...args)
}));

const { CloneError } = vi.hoisted(() => {
  class CloneError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return { CloneError };
});

vi.mock('$lib/server/git/clone', () => ({
  cloneInto: (...args: unknown[]) => cloneIntoMock(...args),
  CloneError
}));

vi.mock('$lib/server/git/WorktreeManager', () => ({
  WorktreeManager: {
    ensureDefaultBranch: (...args: unknown[]) => ensureDefaultBranchMock(...args),
    initEmpty: (...args: unknown[]) => initEmptyMock(...args)
  }
}));

vi.mock('$lib/server/user/gitIdentity', () => ({
  resolveGitIdentity: (...args: unknown[]) => resolveGitIdentityMock(...args)
}));

vi.mock('$lib/server/git/client', () => ({
  getGit: (cwd?: string) => getGitMock(cwd)
}));

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args)
}));

import { POST } from './+server.js';

interface CallOpts {
  user?: { id: string; username?: string } | null;
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
  const request = new Request('http://localhost/api/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyStr
  });
  const event = {
    locals: {
      user:
        opts.user === undefined ? { id: 'user-1', username: 'alice' } : opts.user,
      locale: 'en'
    },
    request,
    cookies: { get: () => undefined }
  };
  return POST(event as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  getProjectMock.mockReset();
  insertRepoMock.mockReset();
  cloneIntoMock.mockReset();
  ensureDefaultBranchMock.mockReset();
  initEmptyMock.mockReset();
  resolveGitIdentityMock.mockReset();
  resolveGitIdentityMock.mockReturnValue({ name: 'Alice', email: 'a@x' });
  revparseMock.mockReset();
  getGitMock.mockReset();
  getGitMock.mockReturnValue({ revparse: revparseMock });
  existsSyncMock.mockReset();
  readdirSyncMock.mockReset();
  statSyncMock.mockReset();
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

describe('POST /api/repos — guards', () => {
  it('throws 403 when CSRF fails', async () => {
    await expectThrowStatus(call({ csrfThrows: true, body: { path: '/x' } }), 403);
  });

  it('401 when not signed in', async () => {
    const res = await call({ user: null, body: { path: '/x' } });
    expect(res.status).toBe(401);
  });

  it('400 when body is not valid JSON', async () => {
    const res = await call({ rawBody: 'bad' });
    expect(res.status).toBe(400);
  });

  it('400 when path is missing', async () => {
    const res = await call({ body: {} });
    expect(res.status).toBe(400);
  });

  it('400 when path is not absolute', async () => {
    const res = await call({ body: { path: 'relative/dir' } });
    expect(res.status).toBe(400);
  });

  it('400 when path does not exist', async () => {
    existsSyncMock.mockReturnValue(false);
    const res = await call({ body: { path: '/nope' } });
    expect(res.status).toBe(400);
  });

  it('400 when path is not a directory', async () => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => false });
    const res = await call({ body: { path: '/file' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/repos — project lookups', () => {
  beforeEach(() => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    readdirSyncMock.mockReturnValue([]);
    initEmptyMock.mockResolvedValue(undefined);
  });

  it('400 when referenced project does not exist', async () => {
    getProjectMock.mockReturnValue(undefined);
    const res = await call({ body: { path: '/r', project_id: 'proj-x' } });
    expect(res.status).toBe(400);
  });

  it('403 when project belongs to a different user', async () => {
    getProjectMock.mockReturnValue({
      id: 'proj-x',
      user_id: 'other-user',
      name: 'X',
      default_branch: 'main'
    });
    const res = await call({ body: { path: '/r', project_id: 'proj-x' } });
    expect(res.status).toBe(403);
  });

  it('inherits default_branch from project and stores null on the repo', async () => {
    getProjectMock.mockReturnValue({
      id: 'proj-1',
      user_id: 'user-1',
      name: 'My',
      default_branch: 'develop'
    });
    const res = await call({ body: { path: '/r', project_id: 'proj-1' } });
    expect(res.status).toBe(200);
    expect(initEmptyMock).toHaveBeenCalledWith('/r', 'develop', expect.anything());
    expect(insertRepoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'proj-1',
        default_branch: null
      })
    );
  });
});

describe('POST /api/repos — empty directory init', () => {
  beforeEach(() => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    readdirSyncMock.mockReturnValue([]);
  });

  it('400 when initEmpty throws', async () => {
    initEmptyMock.mockRejectedValue(new Error('git init blew up'));
    const res = await call({ body: { path: '/empty' } });
    expect(res.status).toBe(400);
  });

  it('200 happy path on empty dir uses default branch=main', async () => {
    initEmptyMock.mockResolvedValue(undefined);
    const res = await call({ body: { path: '/empty' } });
    expect(res.status).toBe(200);
    expect(initEmptyMock).toHaveBeenCalledWith('/empty', 'main', expect.anything());
    const body = await res.json();
    expect(body.projectName).toBe('empty');
    expect(insertRepoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/empty',
        project_id: null,
        // Stored value is null when no explicit default_branch was sent
        // (route only uses 'main' as the effective branch for init).
        default_branch: null
      })
    );
  });

  it('200 with explicit default_branch when provided and no project', async () => {
    initEmptyMock.mockResolvedValue(undefined);
    const res = await call({
      body: { path: '/empty', default_branch: 'trunk' }
    });
    expect(res.status).toBe(200);
    expect(initEmptyMock).toHaveBeenCalledWith('/empty', 'trunk', expect.anything());
  });
});

describe('POST /api/repos — clone path', () => {
  beforeEach(() => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    readdirSyncMock.mockReturnValue([]);
  });

  it('200 happy clone + ensureDefaultBranch ok', async () => {
    cloneIntoMock.mockResolvedValue(undefined);
    ensureDefaultBranchMock.mockResolvedValue({ kind: 'ok' });
    const res = await call({
      body: { path: '/empty', clone_url: 'git@x:y.git' }
    });
    expect(res.status).toBe(200);
    expect(cloneIntoMock).toHaveBeenCalledWith('git@x:y.git', '/empty');
  });

  it('400 when CloneError is thrown with auth_failed', async () => {
    cloneIntoMock.mockRejectedValue(new CloneError('auth_failed', 'no key'));
    const res = await call({
      body: { path: '/empty', clone_url: 'git@x:y.git' }
    });
    expect(res.status).toBe(400);
  });

  it('400 when CloneError is thrown with invalid_url', async () => {
    cloneIntoMock.mockRejectedValue(new CloneError('invalid_url', 'nope'));
    const res = await call({
      body: { path: '/empty', clone_url: 'totally-bogus' }
    });
    expect(res.status).toBe(400);
  });

  it('400 when generic Error is thrown during clone', async () => {
    cloneIntoMock.mockRejectedValue(new Error('network'));
    const res = await call({
      body: { path: '/empty', clone_url: 'x' }
    });
    expect(res.status).toBe(400);
  });

  it('400 when ensureDefaultBranch reports no_master after clone', async () => {
    cloneIntoMock.mockResolvedValue(undefined);
    ensureDefaultBranchMock.mockResolvedValue({ kind: 'no_master', current: 'foo' });
    const res = await call({
      body: { path: '/empty', clone_url: 'x', default_branch: 'main' }
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/repos — non-empty directory branch', () => {
  beforeEach(() => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    readdirSyncMock.mockReturnValue(['some-file.txt']);
  });

  it('400 when clone_url is provided into a non-empty dir', async () => {
    const res = await call({
      body: { path: '/dir', clone_url: 'x' }
    });
    expect(res.status).toBe(400);
  });

  it('400 when non-empty dir is not a git repo', async () => {
    revparseMock.mockRejectedValue(new Error('not a git repo'));
    const res = await call({ body: { path: '/dir' } });
    expect(res.status).toBe(400);
  });

  it('400 when ensureDefaultBranch returns no_master on existing repo', async () => {
    revparseMock.mockResolvedValue('.git');
    ensureDefaultBranchMock.mockResolvedValue({ kind: 'no_master', current: null });
    const res = await call({ body: { path: '/dir' } });
    expect(res.status).toBe(400);
  });

  it('200 happy path on existing repo', async () => {
    revparseMock.mockResolvedValue('.git');
    ensureDefaultBranchMock.mockResolvedValue({ kind: 'ok' });
    const res = await call({ body: { path: '/dir' } });
    expect(res.status).toBe(200);
    expect(insertRepoMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/dir' })
    );
  });
});
