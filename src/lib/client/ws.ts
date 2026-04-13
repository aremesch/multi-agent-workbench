/**
 * Reconnecting WebSocket client with snapshot-on-subscribe reconnect.
 *
 * Single shared client per tab: the module-level `getMawWsClient()` lazily
 * creates one instance on first call and auto-connects. Consumers register
 * per-agent handlers via `subscribe(agentId, cols, rows, handlers)` — the
 * dispatch loop routes `output`/`event`/`agent_state`/`scrollback` by
 * `msg.agentId` to the right entry in the handler map.
 *
 * On disconnect, exponential backoff up to 30s. On reconnect, every active
 * subscription is re-issued carrying its last known xterm dims so the
 * server can resize the tmux pane and ship back a fresh capture-pane
 * snapshot (subscribers `term.reset()` before applying it).
 */

import type {
  ClientMessage,
  ServerMessage,
  SC_Output,
  SC_Scrollback,
  SC_HistorySnapshot,
  SC_AgentEvent
} from '$shared/protocol';

export interface AgentHandlers {
  onOutput: (msg: SC_Output) => void;
  onScrollback: (msg: SC_Scrollback) => void;
  /** Optional: out-of-band CLI transcript prepended before live scrollback. */
  onHistorySnapshot?: (msg: SC_HistorySnapshot) => void;
  onEvent: (msg: SC_AgentEvent) => void;
  onState: (status: string) => void;
}

export type ConnectionState = 'open' | 'closed' | 'reconnecting';

interface Sub {
  agentId: string;
  handlers: AgentHandlers;
  /** Last xterm dims reported for this subscription; re-sent on reconnect. */
  cols?: number;
  rows?: number;
}

export class MawWsClient {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Sub>();
  private backoff = 500;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private connectionState: ConnectionState = 'closed';
  private connectionListeners = new Set<(s: ConnectionState) => void>();
  private globalStateListeners = new Set<(agentId: string, status: string) => void>();

  connect(): void {
    if (typeof window === 'undefined') return;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.setConnectionState('reconnecting');

    ws.onopen = () => {
      this.backoff = 500;
      this.setConnectionState('open');
      this.send({ type: 'hello', clientVersion: 1 });
      for (const sub of this.subs.values()) {
        this.send({
          type: 'subscribe_agent',
          agentId: sub.agentId,
          ...(sub.cols !== undefined ? { cols: sub.cols } : {}),
          ...(sub.rows !== undefined ? { rows: sub.rows } : {})
        });
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
      if (this.closed) {
        this.setConnectionState('closed');
        return;
      }
      this.setConnectionState('reconnecting');
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

  /**
   * Register per-agent handlers and send a subscribe message. Subsequent
   * calls for the same agentId replace the stored cols/rows (handlers stay
   * the same — the caller is the single owner of the entry). On reconnect
   * the latest cols/rows are re-issued automatically.
   */
  subscribe(agentId: string, handlers: AgentHandlers, cols?: number, rows?: number): void {
    const existing = this.subs.get(agentId);
    const sub: Sub = existing ?? { agentId, handlers };
    sub.handlers = handlers;
    if (cols !== undefined) sub.cols = cols;
    if (rows !== undefined) sub.rows = rows;
    this.subs.set(agentId, sub);
    this.send({
      type: 'subscribe_agent',
      agentId,
      ...(sub.cols !== undefined ? { cols: sub.cols } : {}),
      ...(sub.rows !== undefined ? { rows: sub.rows } : {})
    });
  }

  unsubscribe(agentId: string): void {
    this.subs.delete(agentId);
    this.send({ type: 'unsubscribe_agent', agentId });
  }

  sendInput(agentId: string, text: string, submit: boolean): void {
    this.send({ type: 'send_input', agentId, text, submit });
  }

  /**
   * Forward raw keystroke bytes (arrow keys, Ctrl-C, Enter, etc.) from an
   * xterm.js instance. `text` is the string xterm handed us via `onData` —
   * it may contain control characters which we ship to the server as base64
   * to survive JSON transport.
   */
  sendKeys(agentId: string, text: string): void {
    if (text.length === 0) return;
    // btoa only accepts latin-1; encode to bytes first so multibyte input
    // (e.g. pasted emoji) round-trips correctly.
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64 = btoa(bin);
    this.send({ type: 'send_keys', agentId, b64 });
  }

  answerPrompt(agentId: string, choice: string | number): void {
    this.send({ type: 'answer_prompt', agentId, choice });
  }

  /** Inform the server of the current xterm.js viewer size so tmux resizes its pane to match. */
  sendResize(agentId: string, cols: number, rows: number): void {
    const sub = this.subs.get(agentId);
    if (sub) {
      sub.cols = cols;
      sub.rows = rows;
    }
    this.send({ type: 'resize', agentId, cols, rows });
  }

  addConnectionListener(cb: (s: ConnectionState) => void): () => void {
    this.connectionListeners.add(cb);
    cb(this.connectionState);
    return () => {
      this.connectionListeners.delete(cb);
    };
  }

  /**
   * Global listener for agent_state messages across every agent — fires
   * even before (or without) a per-agent subscription. Used by the terminal
   * registry to tear down entries when the underlying agent dies.
   */
  addGlobalAgentStateListener(cb: (agentId: string, status: string) => void): () => void {
    this.globalStateListeners.add(cb);
    return () => {
      this.globalStateListeners.delete(cb);
    };
  }

  // ---------- internals ----------

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const cb of this.connectionListeners) cb(state);
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        break;
      case 'output': {
        this.subs.get(msg.agentId)?.handlers.onOutput(msg);
        break;
      }
      case 'scrollback': {
        this.subs.get(msg.agentId)?.handlers.onScrollback(msg);
        break;
      }
      case 'history_snapshot': {
        this.subs.get(msg.agentId)?.handlers.onHistorySnapshot?.(msg);
        break;
      }
      case 'event': {
        this.subs.get(msg.agentId)?.handlers.onEvent(msg);
        break;
      }
      case 'agent_state': {
        for (const cb of this.globalStateListeners) cb(msg.agentId, msg.status);
        this.subs.get(msg.agentId)?.handlers.onState(msg.status);
        break;
      }
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

// ---------- module-level singleton ----------

let singleton: MawWsClient | null = null;

/**
 * Returns the tab-wide shared `MawWsClient`, creating and connecting it on
 * first call. Safe to call during SSR — it no-ops until a real `window` is
 * available (the first browser-side call wins).
 */
export function getMawWsClient(): MawWsClient {
  if (!singleton) {
    singleton = new MawWsClient();
    if (typeof window !== 'undefined') {
      singleton.connect();
    }
  }
  return singleton;
}
