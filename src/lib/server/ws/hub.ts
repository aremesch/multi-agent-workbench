/**
 * WebSocket hub — wires browser clients to AgentRuntimes.
 *
 * Wiring:
 *   - Every incoming ws connection is wrapped in a HubClient.
 *   - HubClient.subscribe(agentId) captures the tmux pane's currently
 *     rendered grid via `tmux capture-pane -p -e -S 0`, anchors xterm's
 *     cursor to tmux's actual cursor cell with a trailing CSI escape, and
 *     ships the result as a `pane_snapshot`. The watermark on the snapshot
 *     is read AFTER capture-pane resolves so it covers every chunk already
 *     represented in the captured grid — bytes that beat the snapshot to
 *     the wire via the live `output` listener are wiped by `term.reset()`
 *     on the client and re-painted by the snapshot itself. From there the
 *     live output/event/state fan-out streams forward. This replaces the
 *     pre-v5 byte-log replay, which stacked redraw banners on TUI CLIs
 *     without alt-screen. See docs/plans/v0.2-terminal-pane-snapshot.md
 *     and docs/plans/v0.2-fix-pane-snapshot-double-prompt.md.
 *   - Inputs from the client go through AgentRuntime's serialized queue.
 *
 * The hub is a singleton (same bootstrap that owns the supervisor).
 */

import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '$shared/protocol';
import { PROTOCOL_VERSION } from '$shared/protocol';
import { auth } from '../auth/betterAuth.js';
import { logAuth } from '../auth/authLog.js';
import { clientIpFromRaw } from '../net/clientIp.js';
import { getConfig } from '../config.js';
import { getSupervisor } from '../bootstrap.js';
import { Tmux } from '../tmux/TmuxSession.js';
import type { AgentRuntime } from '../agents/AgentRuntime.js';
import { getAgent, getLatestTerminalSeq } from '../db/queries.js';
import { isStreamKind } from '../agents/AgentSupervisor.js';
import { getPlaywrightSessions } from '../preview/PlaywrightSessionManager.js';
import type { PlaywrightSession, StreamFrame } from '../preview/PlaywrightSession.js';
import type { Cookies } from '@sveltejs/kit';

interface Subscription {
  agentId: string;
  runtime: AgentRuntime;
  offOutput: () => void;
  offEvent: () => void;
  offState: () => void;
  offAlert: () => void;
}

interface StreamSubscription {
  agentId: string;
  session: PlaywrightSession;
  offFrame: () => void;
  offUrl: () => void;
  offError: () => void;
  offReady: () => void;
}

class HubClient {
  private subs = new Map<string, Subscription>();
  /** Browser-stream subscriptions live in their own map because they wire
   *  to a Playwright session, not an AgentRuntime, and the message types
   *  flowing in/out are different. */
  private streamSubs = new Map<string, StreamSubscription>();

  constructor(
    private readonly ws: WebSocket,
    public readonly userId: string
  ) {
    this.send({ type: 'welcome', serverVersion: PROTOCOL_VERSION, userId });
    ws.on('message', (raw) => this.onMessage(raw.toString('utf8')));
    ws.on('close', () => this.cleanup());
    ws.on('error', () => this.cleanup());
  }

  private send(msg: ServerMessage): void {
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // socket is closing; ignore
    }
  }

  private onMessage(raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send({ type: 'error', code: 'bad_json', message: 'invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'hello':
        // already welcomed; no-op
        break;
      case 'ping':
        this.send({ type: 'pong', ts: msg.ts });
        break;
      case 'subscribe_agent':
        this.handleSubscribe(msg.agentId);
        break;
      case 'unsubscribe_agent':
        this.handleUnsubscribe(msg.agentId);
        this.handleStreamUnsubscribe(msg.agentId);
        break;
      case 'send_input':
        this.handleSendInput(msg.agentId, msg.text, msg.submit);
        break;
      case 'send_keys':
        this.handleSendKeys(msg.agentId, msg.b64);
        break;
      case 'resize':
        this.handleResize(msg.agentId, msg.cols, msg.rows);
        break;
      case 'answer_prompt':
        this.handleAnswerPrompt(msg.agentId, msg.choice);
        break;
      case 'control':
        this.handleControl(msg.agentId, msg.action);
        break;
      case 'assign_task':
        this.handleAssignTask(msg.agentId, msg.task);
        break;
      case 'stream_pointer':
        this.handleStreamPointer(msg.agentId, msg.kind, msg.x, msg.y, msg.button, msg.buttons);
        break;
      case 'stream_wheel':
        this.handleStreamWheel(msg.agentId, msg.x, msg.y, msg.deltaX, msg.deltaY);
        break;
      case 'stream_key':
        this.handleStreamKey(msg.agentId, msg.kind, msg.key, msg.code, msg.modifiers);
        break;
      case 'stream_text':
        this.handleStreamText(msg.agentId, msg.text);
        break;
      case 'stream_viewport':
        this.handleStreamViewport(msg.agentId, msg.width, msg.height, msg.deviceScaleFactor);
        break;
      case 'stream_frame_ack':
        this.handleStreamFrameAck(msg.agentId, msg.sessionId);
        break;
      case 'stream_navigate':
        this.handleStreamNavigate(msg.agentId, msg.url);
        break;
      case 'stream_history':
        this.handleStreamHistory(msg.agentId, msg.action);
        break;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  private handleSubscribe(agentId: string): void {
    // Browser-stream agents have no AgentRuntime; route to the Playwright
    // session handler. Detect via the DB row's cli_kind so a stale runtime
    // map doesn't accidentally get queried for a stream agent.
    const row = getAgent(agentId);
    if (row && row.user_id === this.userId && isStreamKind(row.cli_kind)) {
      this.handleStreamSubscribe(agentId);
      return;
    }

    if (this.subs.has(agentId)) return;
    const runtime = getSupervisor().get(agentId);
    if (!runtime) {
      this.send({ type: 'error', code: 'not_found', message: `agent ${agentId} not live` });
      return;
    }
    if (runtime.agent.user_id !== this.userId) {
      this.send({ type: 'error', code: 'forbidden', message: 'not your agent' });
      return;
    }

    // Register the fan-out listeners SYNCHRONOUSLY before awaiting anything,
    // so output bytes emitted during the capture-pane await are forwarded
    // live and won't be lost to a race against listener attachment. The
    // terminal_log watermark is read AFTER capture-pane resolves (in the
    // async tail below) so it covers every chunk already represented in the
    // captured grid; live bytes that beat the snapshot to the wire are
    // wiped by `term.reset()` on the client and re-painted by the snapshot
    // ansi itself (tmux pipe-pane fires from the same screen-update event
    // that updates the pane buffer, so a byte in the FIFO is also in the
    // captured grid).
    const onOutput = (payload: { seq: number; chunk: Buffer }): void => {
      this.send({
        type: 'output',
        agentId,
        seq: payload.seq,
        b64: payload.chunk.toString('base64')
      });
    };
    const onEvent = (ev: import('$shared/adapterTypes').AdapterEvent): void => {
      const sc: import('$shared/protocol').SC_AgentEvent = {
        type: 'event',
        agentId,
        kind: ev.kind
      };
      if (ev.patternId !== undefined) sc.patternId = ev.patternId;
      if (ev.choices !== undefined) sc.choices = ev.choices;
      if (ev.detail !== undefined) sc.detail = ev.detail;
      this.send(sc);
    };
    const onState = (status: string): void => {
      this.send({ type: 'agent_state', agentId, status });
    };
    const onAlert = (alert: { id: string; agentId: string; severity: string; reason: string }): void => {
      this.send({
        type: 'alert',
        id: alert.id,
        agentId: alert.agentId,
        severity: alert.severity as import('$shared/protocol').SC_Alert['severity'],
        reason: alert.reason,
        ts: Math.floor(Date.now() / 1000)
      });
    };

    runtime.on('output', onOutput);
    runtime.on('event', onEvent);
    runtime.on('state', onState);
    runtime.on('alert', onAlert);

    const sub: Subscription = {
      agentId,
      runtime,
      offOutput: () => runtime.off('output', onOutput),
      offEvent: () => runtime.off('event', onEvent),
      offState: () => runtime.off('state', onState),
      offAlert: () => runtime.off('alert', onAlert)
    };
    this.subs.set(agentId, sub);

    // Async tail: capture the current pane grid, anchor xterm's cursor to
    // tmux's actual cursor cell (so live bytes after the snapshot land on
    // the right row/col instead of the bottom-left of an empty pane), then
    // ship the snapshot. The watermark is read AFTER capture-pane resolves
    // so the snapshot's `seq` covers every chunk already in the captured
    // grid; the client uses it to dedup future live `output` frames.
    void (async () => {
      let ansi = '';
      try {
        ansi = await Tmux.capturePane(runtime.tmuxSession, 0);
      } catch (err) {
        console.warn(`[hub] capture-pane failed for ${agentId}:`, err);
      }
      // capture-pane emits bare LF between rows. xterm runs with
      // convertEol: false (so live PTY bytes keep their CR exactly where
      // the child emitted them), which means a bare LF just moves the
      // cursor down one row without returning to column 0 — the snapshot
      // would paint a staircase instead of a grid. Normalize to CRLF here
      // so the snapshot lands aligned; the pattern `\r?\n` makes the
      // rewrite idempotent if a future tmux build ever adds CRs.
      if (ansi.length > 0) ansi = ansi.replace(/\r?\n/g, '\r\n');
      // Anchor xterm's cursor at tmux's actual cursor cell. Without this,
      // writing the captured grid (rows of CRLF-terminated text) leaves
      // xterm's cursor at the bottom of the pane — and any live byte that
      // arrives next paints there instead of where the running program
      // expects (e.g. right after a bash `$ ` prompt at row 0).
      if (ansi.length > 0) {
        const cursor = await Tmux.getCursorPosition(runtime.tmuxSession);
        if (cursor) ansi += `\x1b[${cursor.y + 1};${cursor.x + 1}H`;
      }
      // Read AFTER capture-pane resolves so the watermark covers every
      // chunk already represented in the captured grid (no double-paint
      // via a catch-up replay; the snapshot is authoritative).
      const snapshotSeq = getLatestTerminalSeq(agentId);
      // Short-circuit if the client unsubscribed (or the ws closed) while
      // capture-pane was resolving — no need to ship stale snapshots.
      if (this.subs.get(agentId) !== sub) return;
      this.send({ type: 'pane_snapshot', agentId, ansi, seq: snapshotSeq });
    })();
  }

  private handleUnsubscribe(agentId: string): void {
    const sub = this.subs.get(agentId);
    if (!sub) return;
    sub.offOutput();
    sub.offEvent();
    sub.offState();
    sub.offAlert();
    this.subs.delete(agentId);
  }

  private handleSendInput(agentId: string, text: string, submit: boolean): void {
    const runtime = getSupervisor().get(agentId);
    if (!runtime || runtime.agent.user_id !== this.userId) return;
    runtime.enqueueInput(text, submit).catch((err) => {
      this.send({ type: 'error', code: 'input_failed', message: String(err) });
    });
  }

  private handleSendKeys(agentId: string, b64: string): void {
    const runtime = getSupervisor().get(agentId);
    if (!runtime || runtime.agent.user_id !== this.userId) return;
    let text: string;
    try {
      text = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      this.send({ type: 'error', code: 'bad_payload', message: 'send_keys: invalid base64' });
      return;
    }
    runtime.enqueueRawKeys(text).catch((err) => {
      this.send({ type: 'error', code: 'input_failed', message: String(err) });
    });
  }

  private handleResize(agentId: string, cols: number, rows: number): void {
    const runtime = getSupervisor().get(agentId);
    if (!runtime || runtime.agent.user_id !== this.userId) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    runtime.resize(cols, rows).catch((err) => {
      this.send({ type: 'error', code: 'resize_failed', message: String(err) });
    });
  }

  private handleAnswerPrompt(agentId: string, choice: string | number): void {
    const runtime = getSupervisor().get(agentId);
    if (!runtime || runtime.agent.user_id !== this.userId) return;
    runtime.enqueueAnswer(choice).catch((err) => {
      this.send({ type: 'error', code: 'answer_failed', message: String(err) });
    });
  }

  private handleControl(agentId: string, action: 'stop' | 'sigint' | 'restart'): void {
    const sup = getSupervisor();
    const runtime = sup.get(agentId);
    if (!runtime || runtime.agent.user_id !== this.userId) return;
    if (action === 'sigint') {
      Tmux.sendKey(runtime.tmuxSession, 'C-c').catch(() => {});
    } else if (action === 'stop') {
      sup.kill(agentId).catch((err) => {
        this.send({ type: 'error', code: 'kill_failed', message: String(err) });
      });
    } else if (action === 'restart') {
      this.send({ type: 'error', code: 'not_implemented', message: 'restart not in v0.1' });
    }
  }

  private handleAssignTask(agentId: string, task: { title: string; body: string }): void {
    const runtime = getSupervisor().get(agentId);
    if (!runtime || runtime.agent.user_id !== this.userId) return;
    // v0.1: just forward the task body as input. Task-table bookkeeping comes later.
    runtime.enqueueInput(task.body, true).catch(() => {});
  }

  // ─────────── browser-stream (Playwright) subscriptions ──────────────

  private handleStreamSubscribe(agentId: string): void {
    if (this.streamSubs.has(agentId)) return;
    const session = getPlaywrightSessions().get(agentId);
    if (!session) {
      this.send({ type: 'stream_error', agentId, message: 'session not running' });
      return;
    }

    const onFrame = (f: StreamFrame): void => {
      this.send({
        type: 'stream_frame',
        agentId,
        sessionId: f.sessionId,
        b64: f.b64,
        width: f.width,
        height: f.height
      });
    };
    const onUrl = (url: string): void => {
      this.send({ type: 'stream_url', agentId, url });
    };
    const onError = (msg: string): void => {
      this.send({ type: 'stream_error', agentId, message: msg });
    };
    const onReady = (url: string): void => {
      this.send({ type: 'stream_ready', agentId, url });
    };

    session.on('frame', onFrame);
    session.on('url', onUrl);
    session.on('error', onError);
    session.on('ready', onReady);

    this.streamSubs.set(agentId, {
      agentId,
      session,
      offFrame: () => session.off('frame', onFrame),
      offUrl: () => session.off('url', onUrl),
      offError: () => session.off('error', onError),
      offReady: () => session.off('ready', onReady)
    });

    // The session is already running by the time we subscribe (spawn awaits
    // start()). Send an immediate `stream_ready` so the client can paint
    // its toolbar URL bar without waiting for a navigation event.
    this.send({ type: 'stream_ready', agentId, url: session.url });

    // Replay the most recent CDP frame so the StreamView paints immediately.
    // Without this, a subscriber that connects after Chromium already
    // rendered the page (e.g. spawn → navigate → /agents/<id>) would sit on
    // the "Connecting…" placeholder until the next visible change, since
    // CDP only emits frames on page mutation.
    const last = session.lastFrame;
    if (last) {
      this.send({
        type: 'stream_frame',
        agentId,
        sessionId: last.sessionId,
        b64: last.b64,
        width: last.width,
        height: last.height
      });
    }
  }

  private streamSession(agentId: string): PlaywrightSession | null {
    const sub = this.streamSubs.get(agentId);
    if (!sub) return null;
    return sub.session;
  }

  private handleStreamPointer(
    agentId: string,
    kind: 'move' | 'down' | 'up',
    x: number,
    y: number,
    button: number,
    buttons: number
  ): void {
    const session = this.streamSession(agentId);
    if (!session) return;
    void session.dispatchPointer(kind, x, y, button, buttons);
  }

  private handleStreamWheel(agentId: string, x: number, y: number, dx: number, dy: number): void {
    const session = this.streamSession(agentId);
    if (!session) return;
    void session.dispatchWheel(x, y, dx, dy);
  }

  private handleStreamKey(
    agentId: string,
    kind: 'down' | 'up',
    key: string,
    code: string,
    modifiers: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }
  ): void {
    const session = this.streamSession(agentId);
    if (!session) return;
    void session.dispatchKey(kind, key, code, modifiers);
  }

  private handleStreamText(agentId: string, text: string): void {
    const session = this.streamSession(agentId);
    if (!session) return;
    void session.dispatchText(text);
  }

  private handleStreamViewport(
    agentId: string,
    width: number,
    height: number,
    deviceScaleFactor?: number
  ): void {
    const session = this.streamSession(agentId);
    if (!session) return;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) return;
    void session.setViewport(Math.floor(width), Math.floor(height), deviceScaleFactor ?? 1);
  }

  private handleStreamFrameAck(agentId: string, sessionId: number): void {
    const session = this.streamSession(agentId);
    if (!session) return;
    void session.ackFrame(sessionId);
  }

  private handleStreamNavigate(agentId: string, url: string): void {
    const session = this.streamSession(agentId);
    if (!session) return;
    void session.navigate(url);
  }

  private handleStreamHistory(agentId: string, action: 'reload' | 'back' | 'forward'): void {
    const session = this.streamSession(agentId);
    if (!session) return;
    void session.historyAction(action);
  }

  private handleStreamUnsubscribe(agentId: string): void {
    const sub = this.streamSubs.get(agentId);
    if (!sub) return;
    sub.offFrame();
    sub.offUrl();
    sub.offError();
    sub.offReady();
    this.streamSubs.delete(agentId);
  }

  private cleanup(): void {
    for (const id of Array.from(this.subs.keys())) {
      this.handleUnsubscribe(id);
    }
    for (const id of Array.from(this.streamSubs.keys())) {
      this.handleStreamUnsubscribe(id);
    }
  }
}

export class WsHub {
  private clients = new Set<HubClient>();

  attach(ws: WebSocket, req: IncomingMessage): void {
    // Origin check — browsers send Origin on the upgrade handshake; if it
    // doesn't match MAW_PUBLIC_ORIGIN we refuse. Skipped when publicOrigin
    // is unset (dev) or the request carries no Origin (non-browser client,
    // e.g. server-side test harness).
    const allowedOrigin = getConfig().publicOrigin;
    const origin = req.headers.origin;
    const ua = Array.isArray(req.headers['user-agent'])
      ? req.headers['user-agent'][0]
      : req.headers['user-agent'];
    if (allowedOrigin && origin && origin !== allowedOrigin) {
      const ip = clientIpFromRaw(req);
      logAuth('ws_origin_reject', { ip, userAgent: ua ?? null, detail: origin });
      ws.close(4403, 'origin');
      return;
    }

    // Async session lookup via better-auth. handleUpgrade()'s callback is
    // sync, so we kick the lookup off and close the socket on rejection
    // from inside the promise chain.
    void this.attachAsync(ws, req).catch((err) => {
      console.error('[ws] attach error:', err);
      try {
        ws.close(4500, 'internal');
      } catch {
        // socket already closed
      }
    });
  }

  private async attachAsync(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // Build a Headers from the raw upgrade-request headers so better-auth
    // can read the (signed) session cookie out of the Cookie header.
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    const sess = await auth.api.getSession({ headers });
    if (!sess) {
      ws.close(4401, 'unauthenticated');
      return;
    }
    const client = new HubClient(ws, sess.user.id);
    this.clients.add(client);
    ws.on('close', () => this.clients.delete(client));
  }
}

// globalThis-backed so the esbuild-bundled server.js and SvelteKit's chunk
// copy of this module share the same hub instance.
const G = globalThis as unknown as { __maw_ws_hub?: WsHub };
export function getWsHub(): WsHub {
  if (!G.__maw_ws_hub) G.__maw_ws_hub = new WsHub();
  return G.__maw_ws_hub;
}

