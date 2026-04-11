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
import type { AdapterEvent, CliAdapter } from '$shared/adapterTypes';
import type { AgentRow } from '../db/types.js';
import {
  insertEvent,
  insertTerminalChunk,
  updateAgentAttention,
  updateAgentStatus,
  getLatestTerminalSeq
} from '../db/queries.js';
import { FifoStreamer } from '../tmux/FifoStreamer.js';
import { Tmux } from '../tmux/TmuxSession.js';

export interface AgentRuntimeEvents {
  output: (payload: { seq: number; chunk: Buffer }) => void;
  event: (ev: AdapterEvent) => void;
  state: (status: AgentRow['status']) => void;
}

export class AgentRuntime extends EventEmitter {
  private seq: number;
  private inputQueue: Promise<void> = Promise.resolve();
  private fifo: FifoStreamer;
  private stopped = false;

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
    }
  }
}
