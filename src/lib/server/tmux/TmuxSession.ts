/**
 * Thin tmux wrapper via `execa`. All tmux interactions funnel through here
 * so we have one place to debug, test, and mock.
 *
 * Naming: sessions are `maw-agent-<ulid>` (prefix maintained so the reaper
 * can filter `tmux list-sessions`).
 */

import { execa, type ExecaError } from 'execa';

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
   * Scrollback snapshot for new viewers. -e includes escape sequences so the
   * xterm.js client can render colors; -S -10000 grabs ~10k lines of history.
   */
  static async capturePane(session: string): Promise<string> {
    try {
      const { stdout } = await execa('tmux', [
        'capture-pane',
        '-t',
        session,
        '-p',
        '-e',
        '-S',
        '-10000'
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
