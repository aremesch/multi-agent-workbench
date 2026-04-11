/**
 * Thin tmux wrapper via `execa`. All tmux interactions funnel through here
 * so we have one place to debug, test, and mock.
 *
 * Naming: sessions are `maw-agent-<ulid>` (prefix maintained so the reaper
 * can filter `tmux list-sessions`).
 */

import { execa, type ExecaError, type ResultPromise } from 'execa';

export const SESSION_PREFIX = 'maw-agent-';

export interface SpawnOptions {
  session: string;            // e.g. 'maw-agent-<ulid>'
  command: string;            // the CLI binary name
  args: string[];
  env: Record<string, string>;
  cwd: string;
  cols?: number;
  rows?: number;
}

export class Tmux {
  static sessionName(agentId: string): string {
    return `${SESSION_PREFIX}${agentId}`;
  }

  static async hasSession(session: string): Promise<boolean> {
    try {
      await execa('tmux', ['has-session', '-t', session]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a detached tmux session running `command args` in `cwd` with env.
   * We delegate to `sh -lc` so we can carry the env vars through cleanly.
   */
  static async newSession(opts: SpawnOptions): Promise<void> {
    const cols = opts.cols ?? 200;
    const rows = opts.rows ?? 50;

    // Build `env VAR=val ... command args...` as a single shell string.
    const envParts = Object.entries(opts.env).map(
      ([k, v]) => `${k}=${JSON.stringify(v)}`
    );
    const cmdParts = [opts.command, ...opts.args].map((s) => JSON.stringify(s));
    const shellLine = `cd ${JSON.stringify(opts.cwd)} && exec env ${envParts.join(' ')} ${cmdParts.join(' ')}`;

    await execa('tmux', [
      'new-session',
      '-d',
      '-s',
      opts.session,
      '-x',
      String(cols),
      '-y',
      String(rows),
      'sh',
      '-lc',
      shellLine
    ]);
  }

  /** `tmux pipe-pane -o 'cat >> <fifo>'` — open-ended (-o) so restarts replace cleanly. */
  static async pipePane(session: string, fifoPath: string): Promise<void> {
    await execa('tmux', [
      'pipe-pane',
      '-o',
      '-t',
      session,
      `cat >> ${JSON.stringify(fifoPath)}`
    ]);
  }

  /** Stop pipe-pane for the session. */
  static async stopPipePane(session: string): Promise<void> {
    try {
      await execa('tmux', ['pipe-pane', '-t', session]);
    } catch {
      // ignore — session may already be gone
    }
  }

  /**
   * Type literal text into the pane (no key-name interpretation). Callers
   * should follow with a separate `Enter` / submit key if submission is
   * desired — keeps the surface explicit.
   */
  static async sendLiteral(session: string, text: string): Promise<void> {
    if (text.length === 0) return;
    await execa('tmux', ['send-keys', '-t', session, '-l', '--', text]);
  }

  /** Send a named tmux key like 'Enter' or 'C-c'. */
  static async sendKey(session: string, key: string): Promise<void> {
    await execa('tmux', ['send-keys', '-t', session, key]);
  }

  /**
   * Resize a detached session's window to the given dimensions. Used when an
   * xterm.js viewer attaches and wants the pane to stop wrapping at the
   * original spawn size (200x50) and match its own visible columns/rows.
   */
  static async resizeWindow(session: string, cols: number, rows: number): Promise<void> {
    if (cols < 1 || rows < 1) return;
    try {
      await execa('tmux', [
        'resize-window',
        '-t',
        session,
        '-x',
        String(Math.floor(cols)),
        '-y',
        String(Math.floor(rows))
      ]);
    } catch (err) {
      const e = err as ExecaError;
      const stderr = typeof e.stderr === 'string' ? e.stderr : '';
      // "can't find session" means the pane is already gone — ignore.
      if (!/can't find session|session not found/i.test(stderr)) throw err;
    }
  }

  /**
   * Scrollback snapshot for new viewers. -e includes escape sequences so the
   * xterm.js client can render colors; -S <startLine> chooses how far back to
   * grab (default -10000 ≈ 10k lines). Pass e.g. -50 for a compact thumbnail.
   */
  static async capturePane(session: string, startLine = -10000): Promise<string> {
    try {
      const { stdout } = await execa('tmux', [
        'capture-pane',
        '-t',
        session,
        '-p',
        '-e',
        '-S',
        String(startLine)
      ]);
      return stdout;
    } catch {
      return '';
    }
  }

  static async killSession(session: string): Promise<void> {
    try {
      await execa('tmux', ['kill-session', '-t', session]);
    } catch (err) {
      const e = err as ExecaError;
      // "can't find session" is fine — idempotent kill.
      const stderr = typeof e.stderr === 'string' ? e.stderr : '';
      if (!/can't find session|session not found/i.test(stderr)) throw err;
    }
  }

  /**
   * Install a `session-closed` hook on the given tmux session so that when
   * the session ends (CLI exited, window closed, killed, …) tmux signals a
   * wait-for channel we can block on from Node. Paired with
   * `spawnWaitForChannel` to get event-driven exit detection instead of
   * polling `tmux list-sessions` every REAP_INTERVAL_MS.
   *
   * The hook command is parsed directly by tmux's command parser — no shell
   * involved — so keep `channel` alphanumeric + dashes. We use
   * `maw-exit-<agentId>` in AgentSupervisor, which is safe.
   */
  static async setSessionClosedSignal(session: string, channel: string): Promise<void> {
    await execa('tmux', [
      'set-hook',
      '-t',
      session,
      'session-closed',
      `wait-for -S ${channel}`
    ]);
  }

  /**
   * Fork a `tmux wait-for <channel>` client that blocks until another tmux
   * command signals the channel via `wait-for -S <channel>` (typically from
   * the session-closed hook installed by `setSessionClosedSignal`).
   *
   * Returns the execa subprocess so the caller can both `await` its
   * resolution AND `kill()` it if the agent is torn down through another
   * path (manual `killSession`, supervisor shutdown, etc.) so we don't
   * leak a subprocess per reaped-another-way agent.
   */
  static spawnWaitForChannel(channel: string): ResultPromise {
    return execa('tmux', ['wait-for', channel]);
  }

  /** List every `maw-agent-*` session currently present on the host. */
  static async listMawSessions(): Promise<string[]> {
    try {
      const { stdout } = await execa('tmux', ['list-sessions', '-F', '#{session_name}']);
      return stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.startsWith(SESSION_PREFIX));
    } catch {
      return [];
    }
  }
}
