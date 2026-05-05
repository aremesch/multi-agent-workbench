import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getFsBrowseRootMock = vi.fn();
const listDirectoryMock = vi.fn();

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

vi.mock('$lib/server/config', () => ({
  getFsBrowseRoot: () => getFsBrowseRootMock()
}));

vi.mock('$lib/server/fs/browse', () => ({
  BrowseError,
  listDirectory: (...args: unknown[]) => listDirectoryMock(...args)
}));

import { GET } from './+server.js';

interface CallOpts {
  user?: { id: string } | null;
  path?: string;
  hidden?: '0' | '1';
}

async function call(opts: CallOpts = {}): Promise<Response> {
  const url = new URL('http://localhost/api/fs/list');
  if (opts.path !== undefined) url.searchParams.set('path', opts.path);
  if (opts.hidden) url.searchParams.set('hidden', opts.hidden);
  const event = {
    locals: {
      user: opts.user === undefined ? { id: 'user-1' } : opts.user,
      locale: 'en'
    },
    url
  };
  return GET(event as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
  getFsBrowseRootMock.mockReset();
  getFsBrowseRootMock.mockReturnValue('/home/alice');
  listDirectoryMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/fs/list', () => {
  it('401 when not signed in', async () => {
    const res = await call({ user: null });
    expect(res.status).toBe(401);
    expect(listDirectoryMock).not.toHaveBeenCalled();
  });

  it('200 with root + entries on happy path', async () => {
    listDirectoryMock.mockReturnValue({
      path: '/home/alice/code',
      parent: '/home/alice',
      entries: [{ name: 'maw', isGitRepo: true }]
    });
    const res = await call({ path: '/home/alice/code' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root).toBe('/home/alice');
    expect(body.path).toBe('/home/alice/code');
    expect(body.entries).toEqual([{ name: 'maw', isGitRepo: true }]);
    expect(listDirectoryMock).toHaveBeenCalledWith(
      '/home/alice/code',
      '/home/alice',
      { showHidden: false }
    );
  });

  it('passes showHidden=true when hidden=1', async () => {
    listDirectoryMock.mockReturnValue({ path: '/x', parent: '/', entries: [] });
    await call({ path: '/x', hidden: '1' });
    expect(listDirectoryMock).toHaveBeenCalledWith('/x', '/home/alice', {
      showHidden: true
    });
  });

  it('uses null path arg when omitted (helper resolves default)', async () => {
    listDirectoryMock.mockReturnValue({ path: '/home/alice', parent: null, entries: [] });
    await call();
    expect(listDirectoryMock).toHaveBeenCalledWith(null, '/home/alice', {
      showHidden: false
    });
  });

  it('403 when listDirectory throws outside_root', async () => {
    listDirectoryMock.mockImplementation(() => {
      throw new BrowseError('outside_root', 'nope');
    });
    const res = await call({ path: '/etc' });
    expect(res.status).toBe(403);
  });

  it('404 when listDirectory throws not_found', async () => {
    listDirectoryMock.mockImplementation(() => {
      throw new BrowseError('not_found', 'nope');
    });
    const res = await call({ path: '/missing' });
    expect(res.status).toBe(404);
  });

  it('400 when listDirectory throws not_directory', async () => {
    listDirectoryMock.mockImplementation(() => {
      throw new BrowseError('not_directory', 'nope');
    });
    const res = await call({ path: '/home/alice/file.txt' });
    expect(res.status).toBe(400);
  });

  it('400 when listDirectory throws read_failed', async () => {
    listDirectoryMock.mockImplementation(() => {
      throw new BrowseError('read_failed', 'eperm');
    });
    const res = await call({ path: '/locked' });
    expect(res.status).toBe(400);
  });

  it('500 when listDirectory throws an unexpected error', async () => {
    listDirectoryMock.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await call({ path: '/x' });
    expect(res.status).toBe(500);
  });
});
