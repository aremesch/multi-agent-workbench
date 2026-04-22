import { beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.fn();
vi.mock('execa', () => ({
  execa: (cmd: string, args: string[]) => execaMock(cmd, args)
}));

import { Tmux, SESSION_PREFIX } from './TmuxSession.js';

beforeEach(() => {
  execaMock.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

function execaError(stderr: string): Error & { stderr: string } {
  return Object.assign(new Error('execa fail'), { stderr });
}

describe('Tmux.sessionName', () => {
  it('prefixes agent ids with `maw-agent-`', () => {
    expect(Tmux.sessionName('01ABC')).toBe(`${SESSION_PREFIX}01ABC`);
    expect(SESSION_PREFIX).toBe('maw-agent-');
  });
});

describe('Tmux — server + session probes', () => {
  it('assertServerRunning swallows "no server running" — normal at boot', async () => {
    execaMock.mockRejectedValueOnce(
      execaError('no server running on /tmp/tmux-1000/maw')
    );
    await expect(Tmux.assertServerRunning()).resolves.toBeUndefined();
  });

  it('assertServerRunning swallows missing-socket ENOENT', async () => {
    execaMock.mockRejectedValueOnce(
      execaError('error connecting to /tmp/tmux-1000/maw (No such file or directory)')
    );
    await expect(Tmux.assertServerRunning()).resolves.toBeUndefined();
  });

  it('assertServerRunning resolves quietly when server is already up', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    await expect(Tmux.assertServerRunning()).resolves.toBeUndefined();
  });

  it('hasSession returns true when has-session exits 0', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    expect(await Tmux.hasSession('s')).toBe(true);
    expect(execaMock).toHaveBeenCalledWith('tmux', ['-L', 'maw', 'has-session', '-t', 's']);
  });

  it('hasSession returns false when has-session throws', async () => {
    execaMock.mockRejectedValueOnce(execaError("can't find session"));
    expect(await Tmux.hasSession('s')).toBe(false);
  });
});

describe('Tmux.newSession', () => {
  it('builds a -d -s new-session argv with quoted env + command parts', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    await Tmux.newSession({
      session: 'maw-agent-1',
      command: 'bash',
      args: ['-lc', 'echo hi'],
      env: { FOO: 'bar', QUOTED: 'a b' },
      cwd: '/some/cwd',
      cols: 80,
      rows: 24
    });
    const [cmd, args] = execaMock.mock.calls[0];
    expect(cmd).toBe('tmux');
    expect(args.slice(0, 9)).toEqual([
      '-L',
      'maw',
      'new-session',
      '-d',
      '-s',
      'maw-agent-1',
      '-x',
      '80',
      '-y'
    ]);
    expect(args[9]).toBe('24');
    expect(args[10]).toBe('sh');
    expect(args[11]).toBe('-lc');
    const shell = args[12] as string;
    expect(shell).toContain('cd "/some/cwd"');
    expect(shell).toContain('FOO="bar"');
    expect(shell).toContain('QUOTED="a b"');
    expect(shell).toContain('"bash" "-lc" "echo hi"');
  });

  it('defaults cols=120 rows=32 when not given', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    await Tmux.newSession({
      session: 'x',
      command: 'bash',
      args: [],
      env: {},
      cwd: '/'
    });
    const args = execaMock.mock.calls[0][1];
    const xIdx = args.indexOf('-x');
    const yIdx = args.indexOf('-y');
    expect(args[xIdx + 1]).toBe('120');
    expect(args[yIdx + 1]).toBe('32');
  });
});

describe('Tmux — pipePane + stopPipePane', () => {
  it('pipePane wires `cat >> "<fifo>"` without -o so every call destroys+replaces the prior pipe', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    await Tmux.pipePane('sid', '/tmp/x with space/fifo');
    const args = execaMock.mock.calls[0][1];
    expect(args.slice(0, 5)).toEqual(['-L', 'maw', 'pipe-pane', '-t', 'sid']);
    expect(args[5]).toBe('cat >> "/tmp/x with space/fifo"');
  });

  it('pipePane never uses -o — regression guard for the reattach dead-stream bug', async () => {
    // `-o` makes pipe-pane a TOGGLE: if an existing pipe is present (e.g.
    // a surviving `cat` child from the pre-SIGKILL maw process) the flag
    // tells tmux to close the old pipe AND skip opening a new one. The
    // net effect is pane output piped to /dev/null while capture-pane
    // still works — the live terminal stream silently dies across
    // restarts. See docs/plans/v0.2-reattach-live-stream-fix.md.
    execaMock.mockResolvedValueOnce({ stdout: '' });
    await Tmux.pipePane('sid', '/tmp/fifo');
    const args = execaMock.mock.calls[0]![1];
    expect(args).not.toContain('-o');
  });

  it('stopPipePane swallows errors — session may already be gone', async () => {
    execaMock.mockRejectedValueOnce(execaError("can't find session"));
    await expect(Tmux.stopPipePane('sid')).resolves.toBeUndefined();
  });
});

describe('Tmux — key + literal input', () => {
  it('sendLiteral uses `-l` to preserve VT220 escape sequences verbatim', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    await Tmux.sendLiteral('sid', '\x1b[A'); // up-arrow escape
    const args = execaMock.mock.calls[0][1];
    expect(args).toEqual(['-L', 'maw', 'send-keys', '-t', 'sid', '-l', '--', '\x1b[A']);
  });

  it('sendLiteral no-ops on empty text (avoids spurious tmux call)', async () => {
    await Tmux.sendLiteral('sid', '');
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('sendKey passes the key name (no -l) so tmux resolves it', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    await Tmux.sendKey('sid', 'Enter');
    const args = execaMock.mock.calls[0][1];
    expect(args).toEqual(['-L', 'maw', 'send-keys', '-t', 'sid', 'Enter']);
  });
});

describe('Tmux.resizeWindow', () => {
  it('sends resize-window with floored integer dims', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    await Tmux.resizeWindow('sid', 80.9, 24.6);
    const args = execaMock.mock.calls[0][1];
    expect(args.slice(0, 5)).toEqual(['-L', 'maw', 'resize-window', '-t', 'sid']);
    // -x and -y are floored.
    expect(args[6]).toBe('80');
    expect(args[8]).toBe('24');
  });

  it('no-ops when cols or rows < 1', async () => {
    await Tmux.resizeWindow('sid', 0, 24);
    await Tmux.resizeWindow('sid', 80, 0);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('swallows "can\'t find session" (pane gone already)', async () => {
    execaMock.mockRejectedValueOnce(execaError("can't find session: sid"));
    await expect(Tmux.resizeWindow('sid', 80, 24)).resolves.toBeUndefined();
  });

  it('rethrows unrelated tmux errors', async () => {
    execaMock.mockRejectedValueOnce(execaError('unknown option --foo'));
    await expect(Tmux.resizeWindow('sid', 80, 24)).rejects.toThrow();
  });
});

describe('Tmux.capturePane', () => {
  it('defaults to startLine=-10000 (legacy full-scrollback dump)', async () => {
    execaMock.mockResolvedValueOnce({ stdout: 'buf' });
    const out = await Tmux.capturePane('sid');
    expect(out).toBe('buf');
    const args = execaMock.mock.calls[0][1];
    expect(args).toContain('-S');
    expect(args[args.indexOf('-S') + 1]).toBe('-10000');
    expect(args).toContain('-e'); // preserve ANSI
    expect(args).toContain('-p'); // print to stdout
  });

  it('accepts 0 for visible-only (reconnect snapshot mode)', async () => {
    execaMock.mockResolvedValueOnce({ stdout: '' });
    await Tmux.capturePane('sid', 0);
    const args = execaMock.mock.calls[0][1];
    expect(args[args.indexOf('-S') + 1]).toBe('0');
  });

  it('returns empty string on failure — never throws', async () => {
    execaMock.mockRejectedValueOnce(execaError('dead'));
    expect(await Tmux.capturePane('sid')).toBe('');
  });
});

describe('Tmux — session lifecycle', () => {
  it('killSession swallows "can\'t find session" (idempotent)', async () => {
    execaMock.mockRejectedValueOnce(execaError("can't find session: sid"));
    await expect(Tmux.killSession('sid')).resolves.toBeUndefined();
  });

  it('killSession swallows "no server running"', async () => {
    execaMock.mockRejectedValueOnce(execaError('no server running on /tmp/tmux'));
    await expect(Tmux.killSession('sid')).resolves.toBeUndefined();
  });

  it('killSession rethrows unrelated errors', async () => {
    execaMock.mockRejectedValueOnce(execaError('permission denied'));
    await expect(Tmux.killSession('sid')).rejects.toThrow();
  });

  /**
   * Regression guard for the "2 bash agents, exit one → both reaped" bug.
   *
   * tmux's `session-closed` hook CANNOT be usefully scoped per-session:
   * by the time it fires, the closing session's options are gone, so tmux
   * picks an arbitrary remaining session's scope to run the hook under.
   * A per-session (`-t <session>`) `session-closed 'wait-for -S
   * maw-exit-<agentId>'` therefore signals the WRONG agent's exit waiter
   * when any other session closes — cascading false exits. The fix is a
   * server-wide (`-g`) hook that uses `run-shell` + the `#{hook_session_name}`
   * format token so the channel is always derived from the closing session
   * itself. The asserts below pin every part of that contract so a future
   * refactor that reintroduces `-t`, drops `run-shell`, or hard-codes a
   * channel name fails loudly here rather than in production.
   */
  describe('ensureGlobalSessionClosedHook', () => {
    it('installs a SERVER-WIDE (`-g`) session-closed hook, never per-session', async () => {
      execaMock.mockResolvedValueOnce({ stdout: '' });
      await Tmux.ensureGlobalSessionClosedHook();
      const args = execaMock.mock.calls[0]![1] as string[];
      expect(args.slice(0, 5)).toEqual(['-L', 'maw', 'set-hook', '-g', 'session-closed']);
      // Anti-regression: never scope via `-t` for this hook.
      expect(args).not.toContain('-t');
    });

    it('bounces through `run-shell` so format tokens expand', async () => {
      execaMock.mockResolvedValueOnce({ stdout: '' });
      await Tmux.ensureGlobalSessionClosedHook();
      const args = execaMock.mock.calls[0]![1] as string[];
      const hookCmd = args.at(-1)!;
      // run-shell (not a bare `wait-for …`) — raw tmux commands don't
      // expand `#{…}` tokens, so this wrapper is load-bearing.
      expect(hookCmd).toMatch(/^run-shell\b/);
      expect(hookCmd).toContain('-b'); // non-blocking: don't stall tmux's event loop
    });

    it('signals a channel derived from the CLOSING session — not any agent id', async () => {
      execaMock.mockResolvedValueOnce({ stdout: '' });
      await Tmux.ensureGlobalSessionClosedHook();
      const args = execaMock.mock.calls[0]![1] as string[];
      const hookCmd = args.at(-1)!;
      // Must use the closing-session format token, NOT any baked-in agent/session name.
      // Without this the hook fires with whoever-tmux-picked's scope, not
      // the actual closer → cascading false exits (the original bug).
      expect(hookCmd).toContain('#{hook_session_name}');
      expect(hookCmd).toContain('wait-for -S maw-exit-#{hook_session_name}');
      // And it must signal via the dedicated `-L maw` socket.
      expect(hookCmd).toContain('tmux -L maw wait-for');
    });
  });

  describe('Tmux.exitChannel', () => {
    it('derives the channel from the tmux session name (matches the global hook)', () => {
      expect(Tmux.exitChannel('maw-agent-01ABC')).toBe('maw-exit-maw-agent-01ABC');
    });

    it('stays in lock-step with the format token the global hook expands', async () => {
      execaMock.mockResolvedValueOnce({ stdout: '' });
      await Tmux.ensureGlobalSessionClosedHook();
      const args = execaMock.mock.calls[0]![1] as string[];
      const hookCmd = args.at(-1)!;
      // Simulate what tmux does when a session named `maw-agent-FOO` closes:
      // substitute the `#{hook_session_name}` token. The resulting channel
      // MUST be exactly what `Tmux.exitChannel` returns for that session —
      // otherwise per-agent `wait-for` blocks forever.
      const expanded = hookCmd.replace('#{hook_session_name}', 'maw-agent-FOO');
      expect(expanded).toContain(`wait-for -S ${Tmux.exitChannel('maw-agent-FOO')}`);
    });
  });
});

describe('Tmux.listMawSessions', () => {
  it('filters list-sessions output to `maw-agent-*` session names', async () => {
    execaMock.mockResolvedValueOnce({
      stdout: ['maw-agent-one', 'user-session', 'maw-agent-two', ''].join('\n')
    });
    const out = await Tmux.listMawSessions();
    expect(out).toEqual(['maw-agent-one', 'maw-agent-two']);
  });

  it('returns [] when tmux errors (no server yet, etc.)', async () => {
    execaMock.mockRejectedValueOnce(execaError('no server running'));
    expect(await Tmux.listMawSessions()).toEqual([]);
  });
});
