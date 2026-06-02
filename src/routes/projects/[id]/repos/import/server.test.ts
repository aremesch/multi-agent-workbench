import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
const getProjectMock = vi.fn();
const insertRepoMock = vi.fn();
const listReposMock = vi.fn();
const setWsMock = vi.fn();
const listGitRepoChildrenMock = vi.fn();
const ensureMock = vi.fn();

vi.mock('$lib/server/db/queries', () => ({
  getProject: (...a: unknown[]) => getProjectMock(...a),
  insertRepo: (...a: unknown[]) => insertRepoMock(...a),
  listReposForProject: (...a: unknown[]) => listReposMock(...a),
  setProjectWorkspaceRoot: (...a: unknown[]) => setWsMock(...a)
}));

// Keep the real BrowseError so the action's `instanceof` checks work.
vi.mock('$lib/server/fs/browse', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/fs/browse')>(
    '$lib/server/fs/browse'
  );
  return { ...actual, listGitRepoChildren: (...a: unknown[]) => listGitRepoChildrenMock(...a) };
});

vi.mock('$lib/server/config', () => ({ getFsBrowseRoot: () => '/root' }));

vi.mock('$lib/server/git/WorktreeManager', () => ({
  WorktreeManager: { ensureDefaultBranch: (...a: unknown[]) => ensureMock(...a) }
}));

vi.mock('$lib/server/user/gitIdentity', () => ({
  resolveGitIdentity: () => ({ name: 'Tester', email: 't@example.com' })
}));

import { actions } from './+page.server.js';

const WS = '/root/ws';
const ALPHA = '/root/ws/alpha';
const BRAVO = '/root/ws/bravo';

interface RunOpts {
  workspace?: string;
  paths?: string[];
  user?: { id: string; username: string } | null;
}

/**
 * Invoke the default action. Returns either the action's return value
 * (a fail() ActionFailure) or the thrown redirect, normalized.
 */
async function run(
  opts: RunOpts = {}
): Promise<{ kind: 'return'; status: number; data: Record<string, unknown> } | { kind: 'redirect'; status: number; location: string }> {
  const body = new URLSearchParams();
  body.set('workspace_root', opts.workspace ?? WS);
  for (const p of opts.paths ?? [ALPHA, BRAVO]) body.append('paths', p);

  const request = new Request('http://localhost/projects/proj-1/repos/import', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const event = {
    request,
    locals: {
      user: opts.user === undefined ? { id: 'user-1', username: 'tester' } : opts.user,
      locale: 'en'
    },
    params: { id: 'proj-1' }
  };

  const action = actions.default as NonNullable<typeof actions.default>;
  try {
    const res = await action(event as unknown as Parameters<typeof action>[0]);
    const r = res as { status: number; data: Record<string, unknown> };
    return { kind: 'return', status: r.status, data: r.data };
  } catch (err) {
    const e = err as { status?: number; location?: string };
    if (e.location !== undefined) {
      return { kind: 'redirect', status: e.status ?? 0, location: e.location };
    }
    throw err;
  }
}

beforeEach(() => {
  getProjectMock.mockReset().mockReturnValue({
    id: 'proj-1',
    user_id: 'user-1',
    name: 'P',
    default_branch: 'main',
    workspace_root: null
  });
  insertRepoMock.mockReset();
  listReposMock.mockReset().mockReturnValue([]);
  setWsMock.mockReset().mockReturnValue(true);
  ensureMock.mockReset().mockResolvedValue({ kind: 'exists' });
  listGitRepoChildrenMock.mockReset().mockReturnValue({
    path: WS,
    children: [
      { name: 'alpha', path: ALPHA },
      { name: 'bravo', path: BRAVO }
    ]
  });
});

afterEach(() => vi.clearAllMocks());

describe('POST projects/[id]/repos/import', () => {
  it('imports every valid repo, sets workspace_root, and redirects', async () => {
    const res = await run();
    expect(res.kind).toBe('redirect');
    if (res.kind === 'redirect') {
      expect(res.status).toBe(303);
      expect(res.location).toBe('/projects/proj-1');
    }
    expect(insertRepoMock).toHaveBeenCalledTimes(2);
    expect(insertRepoMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'proj-1', path: ALPHA, default_branch: 'main' })
    );
    expect(setWsMock).toHaveBeenCalledWith('proj-1', 'user-1', WS);
  });

  it('skips already-registered repos', async () => {
    listReposMock.mockReturnValue([{ path: ALPHA }]);
    const res = await run();
    expect(res.kind).toBe('redirect');
    expect(insertRepoMock).toHaveBeenCalledTimes(1);
    expect(insertRepoMock).toHaveBeenCalledWith(expect.objectContaining({ path: BRAVO }));
  });

  it('reports per-repo git failures while still importing the siblings', async () => {
    ensureMock.mockImplementation((path: string) =>
      path === ALPHA
        ? Promise.resolve({ kind: 'no_master', current: 'dev' })
        : Promise.resolve({ kind: 'exists' })
    );
    const res = await run();
    expect(res.kind).toBe('return');
    if (res.kind === 'return') {
      expect(res.status).toBe(400);
      expect(res.data.imported).toEqual([BRAVO]);
      expect((res.data.errors as { path: string }[])).toHaveLength(1);
      expect((res.data.errors as { path: string }[])[0]!.path).toBe(ALPHA);
    }
    expect(insertRepoMock).toHaveBeenCalledTimes(1);
    expect(insertRepoMock).toHaveBeenCalledWith(expect.objectContaining({ path: BRAVO }));
    // workspace_root still set because at least one repo imported.
    expect(setWsMock).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite an existing workspace_root', async () => {
    getProjectMock.mockReturnValue({
      id: 'proj-1',
      user_id: 'user-1',
      name: 'P',
      default_branch: 'main',
      workspace_root: '/root/old'
    });
    const res = await run();
    expect(res.kind).toBe('redirect');
    expect(setWsMock).not.toHaveBeenCalled();
  });

  it('400 when workspace_root is missing', async () => {
    const res = await run({ workspace: '' });
    expect(res.kind).toBe('return');
    if (res.kind === 'return') expect(res.status).toBe(400);
    expect(listGitRepoChildrenMock).not.toHaveBeenCalled();
    expect(insertRepoMock).not.toHaveBeenCalled();
  });

  it('400 when no submitted path is a real git child of the workspace', async () => {
    const res = await run({ paths: ['/root/ws/ghost'] });
    expect(res.kind).toBe('return');
    if (res.kind === 'return') expect(res.status).toBe(400);
    expect(insertRepoMock).not.toHaveBeenCalled();
    expect(setWsMock).not.toHaveBeenCalled();
  });
});
