import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock execa before importing the module under test.
vi.mock('execa', () => ({
  execa: vi.fn()
}));

import { execa } from 'execa';
import { CloneError, cloneInto, isAcceptableCloneUrl } from './clone.js';

const execaMock = vi.mocked(execa);

beforeEach(() => {
  execaMock.mockReset();
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
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('shells out to `git clone -- <url> <path>` with prompt-less env', async () => {
    execaMock.mockResolvedValue({} as never);
    await cloneInto('https://example.com/a.git', '/tmp/x');
    expect(execaMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execaMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; timeout: number }
    ];
    expect(cmd).toBe('git');
    expect(args).toEqual(['clone', '--', 'https://example.com/a.git', '/tmp/x']);
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(opts.env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(opts.timeout).toBe(120_000);
  });

  it('maps stderr containing "permission denied" to auth_failed', async () => {
    execaMock.mockRejectedValue({
      stderr: 'git@github.com: Permission denied (publickey).',
      stdout: '',
      message: 'Command failed'
    });
    await expect(cloneInto('git@github.com:a/b.git', '/tmp/x')).rejects.toMatchObject({
      code: 'auth_failed'
    });
  });

  it('maps "authentication failed" to auth_failed', async () => {
    execaMock.mockRejectedValue({
      stderr: 'fatal: Authentication failed for https://github.com/a/b.git',
      message: 'Command failed'
    });
    await expect(cloneInto('https://github.com/a/b.git', '/tmp/x')).rejects.toMatchObject({
      code: 'auth_failed'
    });
  });

  it('maps other failures to clone_failed', async () => {
    execaMock.mockRejectedValue({
      stderr: 'fatal: repository does not exist',
      message: 'Command failed'
    });
    await expect(cloneInto('https://github.com/a/b.git', '/tmp/x')).rejects.toMatchObject({
      code: 'clone_failed'
    });
  });

  it('CloneError is instanceof Error for consumer try/catch', async () => {
    execaMock.mockRejectedValue({ stderr: 'boom', message: 'boom' });
    try {
      await cloneInto('https://x/y.git', '/tmp/x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CloneError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});
