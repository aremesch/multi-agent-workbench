/**
 * AgentRuntime — per-agent live state.
 *
 * Owns: the FifoStreamer, the CliAdapter instance, the serialized input
 * queue → tmux send-keys, the terminal_log writer, and a fan-out
 * EventEmitter that WebSocket clients subscribe to.
 *
 * Inputs from any client go through a single promise chain (`inputQueue`) so
 * simultaneous keystrokes never interleave.
 */

import { EventEmitter } from 'node:events';
import { ulid } from 'ulid';
import type {
  AdapterEvent,
  CliAdapter
} from '$shared/adapterTypes';
import type { AgentRow } from '../db/types.js';
import {
  getTask,
  insertAlert,
  insertEvent,
  insertTerminalChunk,
  listRecentAlerts,
  getUserSetting,
  updateAgentAttention,
  updateAgentStatus,
  getLatestTerminalSeq
} from '../db/queries.js';
import { getPushService } from '../bootstrap.js';
import { PUSH_PREFS_KEY, DEFAULT_NOTIFY_KINDS, parseNotifyKinds, type NotifyKind } from '../push/pushPrefs.js';
import { FifoStreamer } from '../tmux/FifoStreamer.js';
import { Tmux } from '../tmux/TmuxSession.js';

/**
 * Wire-shape of the `alert` event the runtime emits to WS subscribers and
 * (via the user-alerts fanout in the hub) to the dashboard's foreground
 * toast layer. Adds `body` and `url` to what `SC_Alert` already had so
 * the toast doesn't need to round-trip the DB to render.
 */
export interface AlertPayload {
  id: string;
  agentId: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  reason: string;
  body: string;
  /** Deep-link the toast's "Open agent" button navigates to. */
  url: string;
  /** Unix epoch seconds — same as `alerts.ts`. */
  ts: number;
}

export interface AgentRuntimeEvents {
  output: (payload: { seq: number; chunk: Buffer }) => void;
  event: (ev: AdapterEvent) => void;
  state: (status: AgentRow['status']) => void;
  alert: (alert: AlertPayload) => void;
}

/**
 * Window during which a Claude Code hook event suppresses regex-driven
 * alerts on the same agent. Hooks are strictly richer (real `tool_name` +
 * `tool_input.command` from the upstream API), so when both fire the
 * regex alert is dropped to avoid a duplicate notification with worse
 * text. 30 s comfortably covers the lag between the hook firing
 * (microseconds after the upstream API call) and the regex matching the
 * TUI prompt that gets rendered (often hundreds of ms later).
 */
const HOOK_PRIORITY_WINDOW_MS = 30_000;

export class AgentRuntime extends EventEmitter {
  private seq: number;
  private inputQueue: Promise<void> = Promise.resolve();
  private fifo: FifoStreamer;
  private stopped = false;
  // Cache of the last `resize()` call so we don't send a redundant
  // `tmux resize-window` every time a new viewer attaches at the same size.
  // Each real resize delivers SIGWINCH to the CLI, and CLIs that don't use
  // the alt-screen buffer tend to react by re-emitting their current UI,
  // which scrolls the previous version into tmux's main-buffer history.
  // Over many reconnects this accumulates duplicate copies in scrollback
  // that no downstream heuristic can fully recover from.
  private lastResizeCols = 0;
  private lastResizeRows = 0;
  /**
   * Last time `ingestHookEvent` saw a Claude Code hook fire. Used by
   * `maybeAlert` to suppress regex alerts within the priority window — see
   * `HOOK_PRIORITY_WINDOW_MS`. 0 means "no hook ever fired"; legacy /
   * non-claude-code agents stay at 0 forever and the regex path is
   * untouched.
   */
  private lastHookAt = 0;

  constructor(
    public readonly agent: AgentRow,
    private readonly adapter: CliAdapter,
    fifoDir: string
  ) {
    super();
    this.seq = getLatestTerminalSeq(agent.id);
    this.fifo = new FifoStreamer({ fifoDir, agentId: agent.id });
  }

  get tmuxSession(): string {
    return this.agent.tmux_session;
  }

  async start(): Promise<void> {
    await this.fifo.create();
    this.fifo.start((chunk) => this.onChunk(chunk));
    await Tmux.pipePane(this.agent.tmux_session, this.fifo.path);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Tmux.stopPipePane(this.agent.tmux_session).catch(() => {});
    await this.fifo.stop();
  }

  /** Serialize input through a promise chain so two keystrokes never interleave. */
  enqueueInput(text: string, submit: boolean): Promise<void> {
    const task = async (): Promise<void> => {
      for (const piece of this.adapter.input.encode(text)) {
        await Tmux.sendLiteral(this.agent.tmux_session, piece);
      }
      if (submit) {
        await Tmux.sendKey(this.agent.tmux_session, 'Enter');
      }
    };
    this.inputQueue = this.inputQueue.then(task, task);
    return this.inputQueue;
  }

  /**
   * Forward raw keystroke bytes from an interactive terminal (e.g. xterm.js
   * `onData`) straight to tmux. Bypasses adapter encoding — control chars
   * like `\x1b[A` or `\x03` must reach the pane verbatim. `send-keys -l`
   * sends the payload literally, so control bytes pass through.
   */
  enqueueRawKeys(text: string): Promise<void> {
    if (text.length === 0) return this.inputQueue;
    const task = async (): Promise<void> => {
      await Tmux.sendLiteral(this.agent.tmux_session, text);
    };
    this.inputQueue = this.inputQueue.then(task, task);
    return this.inputQueue;
  }

  /**
   * Resize the underlying tmux pane to the given dimensions. Called when an
   * xterm.js viewer fits its container and needs the CLI to redraw at those
   * columns/rows (otherwise output wraps at the original spawn size).
   *
   * No-op if the pane was already resized to these dimensions — see
   * `lastResizeCols`/`lastResizeRows` above for the reasoning. Idempotent
   * on identical calls, so viewers repeatedly re-attaching at the same
   * size never provoke a redraw burst.
   */
  async resize(cols: number, rows: number): Promise<void> {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
      return;
    }
    if (cols === this.lastResizeCols && rows === this.lastResizeRows) {
      return;
    }
    await Tmux.resizeWindow(this.agent.tmux_session, cols, rows);
    this.lastResizeCols = cols;
    this.lastResizeRows = rows;
  }

  enqueueAnswer(choice: string | number): Promise<void> {
    const keys = this.adapter.input.answerPrompt(choice);
    const task = async (): Promise<void> => {
      for (const key of keys) {
        if (key === 'Enter' || /^[A-Z]/.test(key) || key.startsWith('C-')) {
          await Tmux.sendKey(this.agent.tmux_session, key);
        } else {
          await Tmux.sendLiteral(this.agent.tmux_session, key);
        }
      }
    };
    this.inputQueue = this.inputQueue.then(task, task);
    return this.inputQueue;
  }

  /**
   * Pipe a Claude Code hook payload (delivered to `/api/internal/claude-hook`
   * via the per-agent bearer-authed loopback POST) into the same downstream
   * processing as a regex-detected adapter event.
   *
   * The payload shape is what Claude Code emits on stdin to its hook command
   * (https://code.claude.com/docs/en/hooks.md):
   *
   *   { hook_event_name: "Notification" | "PreToolUse" | ...,
   *     session_id: string,
   *     tool_name?: string,
   *     tool_input?: { command?, file_path?, description?, ... },
   *     tool_use_id?: string,
   *     notification_type?: "permission_prompt" | "idle_prompt" | ... }
   *
   * Mapping:
   *   - `Notification` with a prompt-flavoured `notification_type` →
   *     `prompt_detected` with the tool/command surfaced via `detail`.
   *   - `PreToolUse` is observed for dedup (it stamps `lastHookAt` so the
   *     regex pipeline stays quiet) but does NOT itself create an alert —
   *     too noisy without a way to know whether the user is actually
   *     being asked to approve.
   *   - All other events: silent no-op (PostToolUse, Stop, SessionEnd…).
   *
   * No-op once `stop()` has been called (a stale curl arriving after the
   * runtime tore down).
   */
  ingestHookEvent(payload: Record<string, unknown>): void {
    if (this.stopped) return;
    const eventName = String(payload.hook_event_name ?? '');
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
    const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null;
    const ti = (payload.tool_input ?? {}) as Record<string, unknown>;

    const detail: Record<string, unknown> = {};
    if (toolName) detail.tool = toolName;
    if (typeof ti.command === 'string') detail.cmd = ti.command;
    if (typeof ti.file_path === 'string') detail.file_path = ti.file_path;
    if (typeof ti.description === 'string') detail.description = ti.description;
    if (toolUseId) detail.tool_use_id = toolUseId;

    if (eventName === 'Notification') {
      const ntype = String(payload.notification_type ?? '');
      const isPromptKind =
        ntype === 'permission_prompt' ||
        ntype === 'idle_prompt' ||
        ntype === 'elicitation_dialog';
      if (!isPromptKind) return;

      this.lastHookAt = Date.now();
      const ev: AdapterEvent = {
        kind: 'prompt_detected',
        at: Date.now(),
        patternId: `claude_hook_${ntype}`,
        detail,
        raw: ''
      };
      this.processEvent(ev, 'hook');
      return;
    }

    if (eventName === 'PreToolUse') {
      // Stamp the marker so the regex path's matching alert is suppressed
      // by `maybeAlert` for the priority window. No alert from PreToolUse
      // itself — it would fire on every tool, including auto-approved ones.
      this.lastHookAt = Date.now();
      return;
    }
    // Everything else: ignored.
  }

  // ---------- internals ----------

  private onChunk(chunk: Buffer): void {
    if (this.stopped) return;

    this.seq++;
    const now = Math.floor(Date.now() / 1000);
    insertTerminalChunk({
      id: ulid(),
      user_id: this.agent.user_id,
      agent_id: this.agent.id,
      seq: this.seq,
      ts: now,
      chunk
    });

    this.emit('output', { seq: this.seq, chunk });

    const events = this.adapter.ingest(chunk);
    for (const ev of events) {
      this.processEvent(ev, 'regex');
    }
  }

  /**
   * Common downstream pipeline for adapter (regex) and hook events:
   * persist to `events`, fan-out on the local emitter, advance the
   * status column, and (for alert-eligible kinds) drive the alert path.
   */
  private processEvent(ev: AdapterEvent, source: 'regex' | 'hook'): void {
    insertEvent({
      id: ulid(),
      user_id: this.agent.user_id,
      agent_id: this.agent.id,
      kind: ev.kind,
      payload_json: JSON.stringify({
        patternId: ev.patternId,
        choices: ev.choices,
        detail: ev.detail,
        source
      }),
      ts: Math.floor(ev.at / 1000)
    });
    this.emit('event', ev);

    if (ev.kind === 'prompt_detected') {
      updateAgentAttention(this.agent.id, Math.floor(ev.at / 1000));
      updateAgentStatus(this.agent.id, 'waiting_input');
      this.emit('state', 'waiting_input');
    } else if (ev.kind === 'task_done') {
      updateAgentStatus(this.agent.id, 'idle');
      this.emit('state', 'idle');
    } else if (ev.kind === 'ready') {
      updateAgentStatus(this.agent.id, 'running');
      this.emit('state', 'running');
    } else if (ev.kind === 'exited') {
      updateAgentStatus(this.agent.id, 'exited');
      this.emit('state', 'exited');
    }

    // Alert pipeline — `exited` is handled by AgentSupervisor.
    if (ev.kind === 'prompt_detected' || ev.kind === 'task_done' || ev.kind === 'error') {
      this.maybeAlert(ev, source);
    }
  }

  private maybeAlert(ev: AdapterEvent, source: 'regex' | 'hook'): void {
    // Hook-vs-regex priority: when a Claude Code hook recently fired for
    // this agent, drop the regex alert. Hooks have richer detail
    // (`tool_input.command` from the upstream API), so the regex match
    // for the same prompt is strictly redundant.
    if (
      source === 'regex' &&
      this.agent.cli_kind === 'claude-code' &&
      this.lastHookAt > 0 &&
      Date.now() - this.lastHookAt < HOOK_PRIORITY_WINDOW_MS
    ) {
      return;
    }

    const notifyKind: NotifyKind = ev.kind as NotifyKind;

    // Per-user notify-kind toggle.
    const prefsRaw = getUserSetting(this.agent.user_id, PUSH_PREFS_KEY);
    const kinds = prefsRaw ? parseNotifyKinds(prefsRaw) : DEFAULT_NOTIFY_KINDS;
    if (!kinds.includes(notifyKind)) return;

    // Dedup: skip if an unacked alert for same (agent, patternId) within 30s.
    const evTs = Math.floor(ev.at / 1000);
    const recent = listRecentAlerts(this.agent.id, evTs - 30);
    const isDupe = recent.some((a) => {
      try {
        return JSON.parse(a.payload_json).patternId === ev.patternId && !a.acknowledged_at;
      } catch { return false; }
    });
    if (isDupe) return;

    const alertId = ulid();
    const reason = alertReason(this.agent, ev);
    const body = alertBody(ev);
    const severity: AlertPayload['severity'] = ev.kind === 'error' ? 'error' : 'info';
    const url = `/repos/${this.agent.repo_id}?agent=${this.agent.id}`;

    insertAlert({
      id: alertId,
      user_id: this.agent.user_id,
      agent_id: this.agent.id,
      severity,
      reason,
      payload_json: JSON.stringify({
        patternId: ev.patternId,
        choices: ev.choices,
        detail: ev.detail,
        body,
        source
      }),
      ts: evTs
    });

    this.emit('alert', {
      id: alertId,
      agentId: this.agent.id,
      severity,
      reason,
      body,
      url,
      ts: evTs
    });

    getPushService()
      .notifyUser(this.agent.user_id, {
        title: reason,
        body,
        data: {
          agentId: this.agent.id,
          alertId,
          url,
          agentTitle: agentDisplayName(this.agent),
          severity
        }
      })
      .catch(() => {}); // fire-and-forget
  }
}

/**
 * Human-readable identifier for an agent in notification payloads.
 * Preference order:
 *   1. The current task's title (set at spawn from the spawn-form input).
 *   2. The CLI kind (`claude-code`, `codex`, …) as a fallback when no
 *      task is associated yet — typically only during a brief boot window.
 *
 * Bypasses any caching layer — `getTask` is a single sqlite point lookup,
 * and alerts are rare. Kept exported for the unit tests + the
 * `agentTitle` payload on the push notification.
 */
export function agentDisplayName(agent: AgentRow): string {
  if (agent.current_task_id) {
    const task = getTask(agent.current_task_id);
    const title = task?.title?.trim();
    if (title) return title;
  }
  return agent.cli_kind;
}

/**
 * Notification title: "<agentTitle> · <reason>". Identifies *which* agent
 * is asking and *what* it's asking, in a single line short enough for
 * mobile lock screens.
 */
export function alertReason(agent: AgentRow, ev: AdapterEvent): string {
  const who = agentDisplayName(agent);
  switch (ev.kind) {
    case 'prompt_detected': {
      const what =
        (typeof ev.detail?.tool === 'string' && ev.detail.tool) ||
        (typeof ev.detail?.action === 'string' && ev.detail.action) ||
        '';
      return what
        ? `${who} · Permission needed: ${what}`
        : `${who} · Permission needed`;
    }
    case 'task_done':
      return `${who} · Task complete`;
    case 'error':
      return ev.patternId ? `${who} · ${ev.patternId}` : `${who} · Error`;
    default:
      return `${who} · ${ev.kind}`;
  }
}

/** Body length cap. Keeps push payloads + toast bodies one-line and the
 *  whole notification under most browsers' 4 KB push budget. */
const BODY_MAX = 200;

/**
 * Notification body: priority chain over adapter / hook detail fields,
 * surfacing the most useful fragment available. Truncated to `BODY_MAX`.
 *
 *   1. `detail.cmd`        — claude-code Bash hook (`tool_input.command`)
 *                            or regex `shell_command_prompt` named group.
 *   2. `detail.file_path`  — claude-code Write/Read hook
 *                            (`tool_input.file_path`).
 *   3. `detail.args`       — regex `tool_permission_prompt` named group.
 *   4. `detail.action`     — codex / gemini regex named group.
 *   5. `ev.choices`        — adapter-declared answer choices.
 *   6. `ev.raw`            — last-resort literal of the matched text.
 *   7. Generic fallback.
 */
export function alertBody(ev: AdapterEvent): string {
  if (ev.kind === 'prompt_detected') {
    const d = (ev.detail ?? {}) as Record<string, unknown>;
    const tool = typeof d.tool === 'string' ? d.tool : '';
    const cmd = typeof d.cmd === 'string' ? d.cmd : '';
    const filePath = typeof d.file_path === 'string' ? d.file_path : '';
    const args = typeof d.args === 'string' ? d.args : '';
    const action = typeof d.action === 'string' ? d.action : '';
    if (cmd) return cmd.slice(0, BODY_MAX);
    if (filePath) return (tool ? `${tool}: ${filePath}` : filePath).slice(0, BODY_MAX);
    if (args) return (tool ? `${tool}(${args})` : args).slice(0, BODY_MAX);
    if (action) return action.slice(0, BODY_MAX);
    if (ev.choices?.length) return `Choices: ${ev.choices.join(', ')}`;
    if (ev.raw) return ev.raw.slice(0, BODY_MAX);
    return 'Agent needs your input.';
  }
  if (ev.kind === 'task_done') return 'Agent has finished its task.';
  if (ev.kind === 'error') {
    const d = (ev.detail ?? {}) as Record<string, unknown>;
    if (typeof d.message === 'string') return d.message.slice(0, BODY_MAX);
    return 'Agent encountered an error.';
  }
  return '';
}
