/**
 * Thin tmux wrapper via `execa`. All tmux interactions funnel through here
 * so we have one place to debug, test, and mock.
 *
 * Naming: sessions are `maw-agent-<ulid>` (prefix maintained so the reaper
 * can filter `tmux list-sessions`).
 */

import { execa, type ExecaError, type ResultPromise } from 'execa';

export const SESSION_PREFIX = 'maw-agent-';

/**
 * Dedicated tmux socket name. All tmux invocations use `-L maw` so the
 * tmux server is separate from any other tmux server the user runs and
 * — critically — lives in its own user systemd unit (`maw-tmux.service`,
 * shipped under `deploy/systemd/`) outside maw.service's cgroup, so
 * `systemctl --user restart maw` does not take the server down with it.
 */
const SOCKET = 'maw';

function t(args: string[]): string[] {
  return ['-L', SOCKET, ...args];
}

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

  /**
   * Probe whether the `-L maw` tmux server is already up. In production it
   * should be owned by the `maw-tmux.service` user unit (see
   * `deploy/systemd/maw-tmux.service`) so it survives `systemctl --user
   * restart maw`. In dev (no systemd, e.g. macOS) it's fine for tmux to
   * auto-spawn on the first `new-session` — we just log a hint.
   *
   * Never throws: a missing server isn't fatal at boot, the first
   * `new-session` will spawn one. We only want to surface the
   * misconfiguration loudly so a prod operator notices.
   */
  static async assertServerRunning(): Promise<void> {
    try {
      await execa('tmux', t(['list-clients']));
    } catch (err) {
      const e = err as ExecaError;
      const stderr = typeof e.stderr === 'string' ? e.stderr : '';
      // Two stderr variants both mean "no tmux server on this socket yet":
      //   - "no server running on /tmp/tmux-.../maw"      (server was up, now gone)
      //   - "error connecting to /tmp/.../maw (No such file or directory)"
      //                                                   (socket file never existed)
      // Both are normal at boot — tmux will auto-spawn on first new-session.
      if (/no server running/i.test(stderr) || /no such file or directory/i.test(stderr)) {
        console.info(
          '[tmux] no server on socket -L maw. In production install maw-tmux.service ' +
          '(see deploy/systemd/maw-tmux.service) so tmux survives `systemctl --user restart maw`. ' +
          'In dev this is fine — tmux will auto-spawn on first session.'
        );
      } else {
        console.warn('[tmux] assertServerRunning probe failed:', err);
      }
    }
  }

  static async hasSession(session: string): Promise<boolean> {
    try {
      await execa('tmux', t(['has-session', '-t', session]));
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
    // Sensible default for headless spawns and for agents viewed before
    // their first xterm resize lands. Once any client subscribes, the
    // hub's resize-then-capture path will re-size the pane to the real
    // viewer dims — so this value only governs the short window before
    // a first viewer attaches, plus the dashboard thumbnail snapshots.
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 32;

    // Build `env VAR=val ... command args...` as a single shell string.
    const envParts = Object.entries(opts.env).map(
      ([k, v]) => `${k}=${JSON.stringify(v)}`
    );
    const cmdParts = [opts.command, ...opts.args].map((s) => JSON.stringify(s));
    const shellLine = `cd ${JSON.stringify(opts.cwd)} && exec env ${envParts.join(' ')} ${cmdParts.join(' ')}`;

    await execa('tmux', t([
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
    ]));
  }

  /**
   * `tmux pipe-pane 'cat >> <fifo>'` — no `-o`.
   *
   * Default (no `-o`) tmux semantics destroy any existing pipe and open a
   * new one. That is what reattach needs: if the previous maw process was
   * SIGKILL'd before it could call `stopPipePane`, tmux may still have
   * `wp->pipe_fd != -1` from a surviving `cat` child. Under `-o` that
   * existing pipe makes the flag a TOGGLE-OFF — tmux closes the old pipe
   * and returns WITHOUT opening a new one, leaving pane output piped to
   * nothing. The live terminal stream silently dies, though `capture-pane`
   * still answers (so thumbnails and reconnect snapshots keep working and
   * the bug looks "only the modal stream is broken").
   *
   * See `docs/plans/v0.2-reattach-live-stream-fix.md` for the full
   * post-mortem.
   */
  static async pipePane(session: string, fifoPath: string): Promise<void> {
    await execa('tmux', t([
      'pipe-pane',
      '-t',
      session,
      `cat >> ${JSON.stringify(fifoPath)}`
    ]));
  }

  /** Stop pipe-pane for the session. */
  static async stopPipePane(session: string): Promise<void> {
    try {
      await execa('tmux', t(['pipe-pane', '-t', session]));
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
    await execa('tmux', t(['send-keys', '-t', session, '-l', '--', text]));
  }

  /** Send a named tmux key like 'Enter' or 'C-c'. */
  static async sendKey(session: string, key: string): Promise<void> {
    await execa('tmux', t(['send-keys', '-t', session, key]));
  }

  /**
   * Resize a detached session's window to the given dimensions. Used when an
   * xterm.js viewer attaches and wants the pane to stop wrapping at the
   * original spawn size (200x50) and match its own visible columns/rows.
   */
  static async resizeWindow(session: string, cols: number, rows: number): Promise<void> {
    if (cols < 1 || rows < 1) return;
    try {
      await execa('tmux', t([
        'resize-window',
        '-t',
        session,
        '-x',
        String(Math.floor(cols)),
        '-y',
        String(Math.floor(rows))
      ]));
    } catch (err) {
      const e = err as ExecaError;
      const stderr = typeof e.stderr === 'string' ? e.stderr : '';
      // "can't find session" means the pane is already gone — ignore.
      if (!/can't find session|session not found/i.test(stderr)) throw err;
    }
  }

  /**
   * Pane snapshot. `-e` preserves ANSI escapes so xterm can render colors;
   * `-S <startLine>` chooses where the capture window begins.
   *
   *   startLine =    0  → visible pane only (tmux "first visible line"),
   *                       the right mode for a reconnect snapshot.
   *   startLine =  -50  → compact thumbnail (dashboard card snapshot).
   *   startLine = -10000 → dump essentially all scrollback (default, legacy).
   *
   * Careful: the legacy default grabs every byte tmux has remembered for the
   * pane, including every partial TUI redraw that landed in the main buffer
   * history. For live viewers always pass `0` — you want what's on screen,
   * not what used to be on screen.
   */
  static async capturePane(session: string, startLine = -10000): Promise<string> {
    try {
      const { stdout } = await execa('tmux', t([
        'capture-pane',
        '-t',
        session,
        '-p',
        '-e',
        '-S',
        String(startLine)
      ]));
      return stdout;
    } catch {
      return '';
    }
  }

  /**
   * Read the pane's cursor coordinates (0-indexed, as tmux stores them) via
   * `display-message -p '#{cursor_x},#{cursor_y}'`. Returns null if the session
   * is gone or the response doesn't parse — callers should then skip the
   * cursor-alignment step of the reconnect snapshot and accept whatever
   * position xterm ends at naturally.
   */
  static async cursorPosition(
    session: string
  ): Promise<{ x: number; y: number } | null> {
    try {
      const { stdout } = await execa('tmux', [
        'display-message',
        '-p',
        '-t',
        session,
        '#{cursor_x},#{cursor_y}'
      ]);
      const m = stdout.trim().match(/^(\d+),(\d+)$/);
      if (!m) return null;
      const x = Number(m[1]);
      const y = Number(m[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    } catch {
      return null;
    }
  }

  static async killSession(session: string): Promise<void> {
    try {
      await execa('tmux', t(['kill-session', '-t', session]));
    } catch (err) {
      const e = err as ExecaError;
      // "can't find session" is fine — idempotent kill.
      const stderr = typeof e.stderr === 'string' ? e.stderr : '';
      if (!/can't find session|session not found|no server running/i.test(stderr)) throw err;
    }
  }

  /**
   * Install the server-wide `session-closed` hook on `-L maw`. Every session
   * that closes fires `wait-for -S maw-exit-<session_name>` via a
   * run-shell bounce, so the per-agent exit waiter resolves the instant
   * that agent's session goes away — and only that agent's waiter.
   *
   * Why global (`-g`) and not per-session (`-t <session>`): when a session
   * closes its own options are already destroyed, so tmux runs the
   * `session-closed` hook using the *remaining* sessions' scope (pick one).
   * A per-session hook therefore fires with the wrong session's scope when
   * *another* session closes — so `wait-for -S maw-exit-<thatOther>`
   * cascades a spurious "exited" event to every live agent every time any
   * single agent ends. The 2-bash-agents-regression: quit agent B → tmux
   * runs agent A's stored `session-closed` hook → agent A is reaped as if
   * it had exited too. See `ensureGlobalSessionClosedHook` test + the
   * "cross-session cascade" regression test in TmuxSession.test.ts.
   *
   * Why run-shell: the raw `wait-for` tmux command does NOT interpolate
   * format tokens. `run-shell`'s argument DOES, so
   * `#{hook_session_name}` expands to the closing session's name, and we
   * bounce out to a child `tmux -L maw wait-for -S …` to signal the
   * channel. `-b` keeps run-shell non-blocking so tmux's event loop is
   * never held up.
   *
   * Idempotent — `set-hook -g` without `-a` replaces.
   */
  static async ensureGlobalSessionClosedHook(): Promise<void> {
    await execa('tmux', t([
      'set-hook',
      '-g',
      'session-closed',
      `run-shell -b "tmux -L ${SOCKET} wait-for -S maw-exit-#{hook_session_name}"`
    ]));
  }

  /**
   * The wait-for channel name the global session-closed hook signals for a
   * given tmux session. Callers block on this via `spawnWaitForChannel` to
   * get event-driven exit detection. Keep in sync with the hook command in
   * `ensureGlobalSessionClosedHook` — they MUST produce the same string.
   */
  static exitChannel(session: string): string {
    return `maw-exit-${session}`;
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
    return execa('tmux', t(['wait-for', channel]));
  }

  /** List every `maw-agent-*` session currently present on the host. */
  static async listMawSessions(): Promise<string[]> {
    try {
      const { stdout } = await execa('tmux', t(['list-sessions', '-F', '#{session_name}']));
      return stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.startsWith(SESSION_PREFIX));
    } catch {
      return [];
    }
  }
}
