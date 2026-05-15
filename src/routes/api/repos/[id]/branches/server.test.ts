import { beforeEach, describe, expect, it, vi } from 'vitest';

const getRepoMock = vi.fn();
const listBranchesMock = vi.fn();

vi.mock('$lib/server/db/queries', () => ({
  getRepo: (id: string) => getRepoMock(id)
}));

vi.mock('$lib/server/git/WorktreeManager', () => ({
  WorktreeManager: { listBranches: (p: string) => listBranchesMock(p) }
}));

import { GET } from './+server.js';

interface CallOpts {
  user?: { id: string } | null;
  repoId?: string;
  repo?: { id: string; user_id: string; path: string } | null;
  branches?: { branches: string[]; current: string | null } | null;
  branchesThrows?: boolean;
}

async function call(opts: CallOpts = {}): Promise<Response> {
  getRepoMock.mockReturnValueOnce(opts.repo === undefined ? { id: 'repo-1', user_id: 'user-1', path: '/repos/one' } : opts.repo);
  if (opts.branchesThrows) {
    listBranchesMock.mockRejectedValueOnce(new Error('git fail'));
  } else if (opts.branches) {
    listBranchesMock.mockResolvedValueOnce(opts.branches);
  }
  const event = {
    locals: {
      user: opts.user === undefined ? { id: 'user-1' } : opts.user,
      locale: 'en'
    },
    params: { id: opts.repoId ?? 'repo-1' }
  };
  return GET(event as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
  getRepoMock.mockReset();
  listBranchesMock.mockReset();
});

describe('GET /api/repos/:id/branches', () => {
  it('401 when not signed in', async () => {
    const res = await call({ user: null });
    expect(res.status).toBe(401);
  });

  it('404 when repo does not exist', async () => {
    const res = await call({ repo: null });
    expect(res.status).toBe(404);
  });

  it('404 when repo is owned by someone else', async () => {
    const res = await call({ repo: { id: 'repo-1', user_id: 'other', path: '/x' } });
    expect(res.status).toBe(404);
  });

  it('200 returns branches + current', async () => {
    const res = await call({
      branches: { branches: ['main', 'feat/x'], current: 'main' }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branches).toEqual(['main', 'feat/x']);
    expect(body.current).toBe('main');
    expect(listBranchesMock).toHaveBeenCalledWith('/repos/one');
  });

  it('500 when listBranches throws', async () => {
    const res = await call({ branchesThrows: true });
    expect(res.status).toBe(500);
  });
});
