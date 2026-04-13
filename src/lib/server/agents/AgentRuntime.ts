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
  CliAdapter,
  HistorySourceSpec,
  ScrollbackMode
} from '$shared/adapterTypes';
import type { AgentRow } from '../db/types.js';
import {
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

export interface AlertPayload {
  id: string;
  agentId: string;
  severity: string;
  reason: string;
}

export interface AgentRuntimeEvents {
  output: (payload: { seq: number; chunk: Buffer }) => void;
  event: (ev: AdapterEvent) => void;
  state: (status: AgentRow['status']) => void;
  alert: (alert: AlertPayload) => void;
}

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

  /**
   * Adapter-declared reconnect snapshot strategy. Exposed here (rather than
   * the hub reaching into `this.adapter` directly) so `adapter` can stay
   * private and the only thing the hub depends on is AgentRuntime's own
   * public surface.
   */
  get scrollbackMode(): ScrollbackMode {
    return this.adapter.scrollbackMode;
  }

  /** Adapter-declared structured history reader, or null. See HistorySourceSpec. */
  get historySource(): HistorySourceSpec | null {
    return this.adapter.historySource;
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
      insertEvent({
        id: ulid(),
        user_id: this.agent.user_id,
        agent_id: this.agent.id,
        kind: ev.kind,
        payload_json: JSON.stringify({
          patternId: ev.patternId,
          choices: ev.choices,
          detail: ev.detail
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
        this.maybeAlert(ev);
      }
    }
  }

  private maybeAlert(ev: AdapterEvent): void {
    const notifyKind: NotifyKind = ev.kind as NotifyKind;

    // Check user preferences.
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
    const reason = alertReason(ev);
    const severity = ev.kind === 'error' ? 'error' as const : 'info' as const;

    insertAlert({
      id: alertId,
      user_id: this.agent.user_id,
      agent_id: this.agent.id,
      severity,
      reason,
      payload_json: JSON.stringify({ patternId: ev.patternId, choices: ev.choices, detail: ev.detail }),
      ts: evTs
    });

    this.emit('alert', { id: alertId, agentId: this.agent.id, severity, reason });

    getPushService().notifyUser(this.agent.user_id, {
      title: `${this.agent.cli_kind}: ${reason}`,
      body: alertBody(ev),
      data: { agentId: this.agent.id, alertId, url: `/repos/${this.agent.repo_id}?agent=${this.agent.id}` }
    }).catch(() => {}); // fire-and-forget
  }
}

function alertReason(ev: AdapterEvent): string {
  switch (ev.kind) {
    case 'prompt_detected':
      return ev.detail?.tool ? `Permission needed: ${ev.detail.tool}` : 'Permission needed';
    case 'task_done':
      return 'Task complete';
    case 'error':
      return ev.patternId ? `Error: ${ev.patternId}` : 'Error';
    default:
      return ev.kind;
  }
}

function alertBody(ev: AdapterEvent): string {
  switch (ev.kind) {
    case 'prompt_detected':
      return ev.choices?.length ? `Choices: ${ev.choices.join(', ')}` : 'Agent needs your input.';
    case 'task_done':
      return 'Agent has finished its task.';
    case 'error':
      return ev.detail?.message ? String(ev.detail.message) : 'Agent encountered an error.';
    default:
      return '';
  }
}
