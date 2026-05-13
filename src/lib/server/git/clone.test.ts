import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SimpleGit } from 'simple-git';

const cloneMock = vi.fn();
const envMock = vi.fn();
const getGitMock = vi.fn();

vi.mock('$lib/server/git/client', () => ({
  getGit: (cwd?: string, overrides?: unknown) => getGitMock(cwd, overrides)
}));

import { CloneError, cloneInto, isAcceptableCloneUrl } from './clone.js';

beforeEach(() => {
  cloneMock.mockReset();
  envMock.mockReset();
  getGitMock.mockReset();
  // Chainable: .env() returns the same git-like object so .clone() can be called next.
  const chain = { env: envMock, clone: cloneMock };
  envMock.mockReturnValue(chain);
  getGitMock.mockReturnValue(chain as unknown as SimpleGit);
});

describe('isAcceptableCloneUrl', () => {
  it('accepts https/http/ssh/git URLs and scp-style', () => {
    expect(isAcceptableCloneUrl('https://github.com/a/b.git')).toBe(true);
    expect(isAcceptableCloneUrl('http://git.local/a/b')).toBe(true);
    expect(isAcceptableCloneUrl('ssh://git@github.com/a/b.git')).toBe(true);
    expect(isAcceptableCloneUrl('git@github.com:a/b.git')).toBe(true);
    expect(isAcceptableCloneUrl('git://github.com/a/b')).toBe(true);
  });

  it('rejects empty, file:// and odd shapes', () => {
    expect(isAcceptableCloneUrl('')).toBe(false);
    expect(isAcceptableCloneUrl('   ')).toBe(false);
    expect(isAcceptableCloneUrl('file:///etc/passwd')).toBe(false);
    expect(isAcceptableCloneUrl('not a url')).toBe(false);
  });
});

describe('cloneInto', () => {
  it('throws invalid_url before shelling out for bad URLs', async () => {
    await expect(cloneInto('not-a-url', '/tmp/x')).rejects.toMatchObject({
      name: 'CloneError',
      code: 'invalid_url'
    });
    expect(getGitMock).not.toHaveBeenCalled();
  });

  it('calls clone with prompt-less env and the configured timeout', async () => {
    cloneMock.mockResolvedValue('');
    await cloneInto('https://example.com/a.git', '/tmp/x');
    expect(getGitMock).toHaveBeenCalledWith(undefined, { timeout: { block: 120_000 } });
    expect(envMock).toHaveBeenCalledTimes(1);
    const envArg = envMock.mock.calls[0]![0] as Record<string, string>;
    expect(envArg.GIT_TERMINAL_PROMPT).toBe('0');
    expect(envArg.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(cloneMock).toHaveBeenCalledWith('https://example.com/a.git', '/tmp/x', ['--']);
  });

  it('maps "permission denied" to auth_failed', async () => {
    cloneMock.mockRejectedValue(
      Object.assign(new Error('git@github.com: Permission denied (publickey).'), {})
    );
    await expect(cloneInto('git@github.com:a/b.git', '/tmp/x')).rejects.toMatchObject({
      code: 'auth_failed'
    });
  });

  it('maps "authentication failed" to auth_failed', async () => {
    cloneMock.mockRejectedValue(
      new Error('fatal: Authentication failed for https://github.com/a/b.git')
    );
    await expect(cloneInto('https://github.com/a/b.git', '/tmp/x')).rejects.toMatchObject({
      code: 'auth_failed'
    });
  });

  it('maps "could not read username" to auth_failed', async () => {
    cloneMock.mockRejectedValue(
      new Error('fatal: could not read Username for https://github.com')
    );
    await expect(cloneInto('https://github.com/a/b.git', '/tmp/x')).rejects.toMatchObject({
      code: 'auth_failed'
    });
  });

  it('maps "host key verification failed" to auth_failed', async () => {
    cloneMock.mockRejectedValue(new Error('Host key verification failed.'));
    await expect(cloneInto('git@github.com:a/b.git', '/tmp/x')).rejects.toMatchObject({
      code: 'auth_failed'
    });
  });

  it('maps other failures to clone_failed', async () => {
    cloneMock.mockRejectedValue(new Error('fatal: repository does not exist'));
    await expect(cloneInto('https://github.com/a/b.git', '/tmp/x')).rejects.toMatchObject({
      code: 'clone_failed'
    });
  });

  it('CloneError is instanceof Error for consumer try/catch', async () => {
    cloneMock.mockRejectedValue(new Error('boom'));
    try {
      await cloneInto('https://x/y.git', '/tmp/x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CloneError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});
