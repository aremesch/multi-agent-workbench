/**
 * Reconnecting WebSocket client with per-agent last-seq replay.
 *
 * Usage:
 *   const c = new MawWsClient({ onOutput, onEvent, onState, onScrollback });
 *   c.connect();
 *   c.subscribe(agentId);
 *
 * On disconnect, exponential backoff up to 30s. On reconnect, every active
 * subscription is re-issued carrying its last-seen seq so the server can
 * replay missed terminal_log chunks.
 */

import type { ClientMessage, ServerMessage, SC_Output, SC_Scrollback, SC_AgentEvent } from '$shared/protocol';

export interface MawWsHandlers {
  onOutput: (msg: SC_Output) => void;
  onScrollback: (msg: SC_Scrollback) => void;
  onEvent: (msg: SC_AgentEvent) => void;
  onState: (status: string) => void;
}

interface Sub {
  agentId: string;
  lastSeq: number;
}

export class MawWsClient {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Sub>();
  private backoff = 500;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly handlers: MawWsHandlers) {}

  connect(): void {
    if (typeof window === 'undefined') return;
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.send({ type: 'hello', clientVersion: 1 });
      for (const sub of this.subs.values()) {
        this.send({ type: 'subscribe_agent', agentId: sub.agentId, lastSeq: sub.lastSeq });
      }
      this.startHeartbeat();
    };

    ws.onmessage = (evt) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(evt.data as string) as ServerMessage;
      } catch {
        return;
      }
      this.dispatch(msg);
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.ws?.close();
  }

  subscribe(agentId: string): void {
    if (!this.subs.has(agentId)) {
      this.subs.set(agentId, { agentId, lastSeq: 0 });
    }
    this.send({ type: 'subscribe_agent', agentId, lastSeq: this.subs.get(agentId)!.lastSeq });
  }

  unsubscribe(agentId: string): void {
    this.subs.delete(agentId);
    this.send({ type: 'unsubscribe_agent', agentId });
  }

  sendInput(agentId: string, text: string, submit: boolean): void {
    this.send({ type: 'send_input', agentId, text, submit });
  }

  answerPrompt(agentId: string, choice: string | number): void {
    this.send({ type: 'answer_prompt', agentId, choice });
  }

  // ---------- internals ----------

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        break;
      case 'output': {
        const sub = this.subs.get(msg.agentId);
        if (sub && msg.seq > sub.lastSeq) sub.lastSeq = msg.seq;
        this.handlers.onOutput(msg);
        break;
      }
      case 'scrollback': {
        const sub = this.subs.get(msg.agentId);
        if (sub) {
          for (const c of msg.chunks) if (c.seq > sub.lastSeq) sub.lastSeq = c.seq;
        }
        this.handlers.onScrollback(msg);
        break;
      }
      case 'event':
        this.handlers.onEvent(msg);
        break;
      case 'agent_state':
        this.handlers.onState(msg.status);
        break;
      case 'pong':
      case 'ack':
      case 'alert':
      case 'message':
      case 'error':
        break;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping', ts: Date.now() });
    }, 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
