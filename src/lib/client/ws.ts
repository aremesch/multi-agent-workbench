/**
 * Reconnecting WebSocket client with pane-snapshot replay on subscribe.
 *
 * Single shared client per tab: the module-level `getMawWsClient()` lazily
 * creates one instance on first call and auto-connects. Consumers register
 * per-agent handlers via `subscribe(agentId, handlers, lastSeq?)` — the
 * dispatch loop routes `output`/`event`/`agent_state`/`pane_snapshot` by
 * `msg.agentId` to the right entry in the handler map.
 *
 * Per-agent `maxSeenSeq` tracks the highest `output.seq` already painted
 * (dedup guard). Protocol v5: `subscribe_agent` carries no `lastSeq` — the
 * server always ships a `pane_snapshot` of the tmux pane's current rendered
 * grid, and any live `output` frames with `seq > snapshot.seq` paint on
 * top. The snapshot sets `maxSeenSeq = snapshot.seq` unconditionally so
 * catch-up re-emits (bytes that slipped past the capture-pane await) are
 * re-applied once even if a live frame beat the snapshot to the wire.
 * On disconnect, exponential backoff up to 30s; active subs auto-resubscribe.
 */

import type {
  ClientMessage,
  ServerMessage,
  SC_Output,
  SC_PaneSnapshot,
  SC_AgentEvent,
  SC_StreamFrame,
  SC_StreamReady,
  SC_StreamUrl,
  SC_StreamError
} from '$shared/protocol';

export interface AgentHandlers {
  onOutput: (msg: SC_Output) => void;
  onPaneSnapshot: (msg: SC_PaneSnapshot) => void;
  onEvent: (msg: SC_AgentEvent) => void;
  onState: (status: string) => void;
  // Browser-stream callbacks. Optional — the iframe AgentTerminalPanel
  // doesn't need them; StreamView wires them up.
  onStreamFrame?: (msg: SC_StreamFrame) => void;
  onStreamReady?: (msg: SC_StreamReady) => void;
  onStreamUrl?: (msg: SC_StreamUrl) => void;
  onStreamError?: (msg: SC_StreamError) => void;
}

export type ConnectionState = 'open' | 'closed' | 'reconnecting';

interface Sub {
  agentId: string;
  handlers: AgentHandlers;
  /** Highest `output.seq` we've already painted; sent as `lastSeq` on reconnect. */
  maxSeenSeq: number;
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
      // Protocol v5: subscribe_agent carries no lastSeq. The server always
      // responds with a pane_snapshot, which resets the xterm grid and
      // re-seeds the dedup watermark.
      for (const sub of this.subs.values()) {
        this.send({ type: 'subscribe_agent', agentId: sub.agentId });
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
   * calls for the same agentId replace the handlers and preserve the
   * existing `maxSeenSeq`. Pass `lastSeq` explicitly only to seed the
   * dedup cursor in tests; it does not travel on the wire (protocol v5
   * drops `lastSeq` — the server's `pane_snapshot` reseats the cursor).
   */
  subscribe(agentId: string, handlers: AgentHandlers, lastSeq?: number): void {
    const existing = this.subs.get(agentId);
    const sub: Sub = existing ?? { agentId, handlers, maxSeenSeq: 0 };
    sub.handlers = handlers;
    if (typeof lastSeq === 'number' && Number.isFinite(lastSeq) && lastSeq > sub.maxSeenSeq) {
      sub.maxSeenSeq = lastSeq;
    }
    this.subs.set(agentId, sub);
    this.send({ type: 'subscribe_agent', agentId });
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
    this.send({ type: 'resize', agentId, cols, rows });
  }

  // ---------- browser-stream input forwarding ----------

  sendStreamPointer(
    agentId: string,
    kind: 'move' | 'down' | 'up',
    x: number,
    y: number,
    button: number,
    buttons: number
  ): void {
    this.send({ type: 'stream_pointer', agentId, kind, x, y, button, buttons });
  }
  sendStreamWheel(agentId: string, x: number, y: number, deltaX: number, deltaY: number): void {
    this.send({ type: 'stream_wheel', agentId, x, y, deltaX, deltaY });
  }
  sendStreamKey(
    agentId: string,
    kind: 'down' | 'up',
    key: string,
    code: string,
    modifiers: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }
  ): void {
    this.send({ type: 'stream_key', agentId, kind, key, code, modifiers });
  }
  sendStreamText(agentId: string, text: string): void {
    if (!text) return;
    this.send({ type: 'stream_text', agentId, text });
  }
  sendStreamViewport(agentId: string, width: number, height: number, deviceScaleFactor?: number): void {
    this.send({ type: 'stream_viewport', agentId, width, height, deviceScaleFactor });
  }
  sendStreamFrameAck(agentId: string, sessionId: number): void {
    this.send({ type: 'stream_frame_ack', agentId, sessionId });
  }
  sendStreamNavigate(agentId: string, url: string): void {
    this.send({ type: 'stream_navigate', agentId, url });
  }
  sendStreamHistory(agentId: string, action: 'reload' | 'back' | 'forward'): void {
    this.send({ type: 'stream_history', agentId, action });
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
        const sub = this.subs.get(msg.agentId);
        if (!sub) break;
        // De-dup against the seq watermark — replay-on-reconnect can carry
        // chunks the client already painted before the WS dropped.
        if (msg.seq <= sub.maxSeenSeq) break;
        sub.maxSeenSeq = msg.seq;
        sub.handlers.onOutput(msg);
        break;
      }
      case 'pane_snapshot': {
        const sub = this.subs.get(msg.agentId);
        if (!sub) break;
        // SET (not max) the watermark to the snapshot's seq. The snapshot
        // represents the pane state at that exact seq; any bytes after it
        // must be re-applied on top, even if a live `output` frame beat
        // the snapshot to the wire during the capture-pane await. The
        // server's catch-up loop resends those bytes and the client dedup
        // (seq > maxSeenSeq) paints them once.
        sub.maxSeenSeq = msg.seq;
        sub.handlers.onPaneSnapshot(msg);
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
      case 'stream_frame': {
        this.subs.get(msg.agentId)?.handlers.onStreamFrame?.(msg);
        break;
      }
      case 'stream_ready': {
        this.subs.get(msg.agentId)?.handlers.onStreamReady?.(msg);
        break;
      }
      case 'stream_url': {
        this.subs.get(msg.agentId)?.handlers.onStreamUrl?.(msg);
        break;
      }
      case 'stream_error': {
        this.subs.get(msg.agentId)?.handlers.onStreamError?.(msg);
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
      if (import.meta.env.DEV) {
        (window as unknown as { __maw_ws_for_test?: MawWsClient }).__maw_ws_for_test = singleton;
      }
    }
  }
  return singleton;
}
