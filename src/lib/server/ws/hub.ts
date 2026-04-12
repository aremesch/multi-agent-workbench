/**
 * WebSocket hub — wires browser clients to AgentRuntimes.
 *
 * Wiring:
 *   - Every incoming ws connection is wrapped in a HubClient.
 *   - HubClient.subscribe(agentId, cols, rows) resizes the agent's tmux pane
 *     to the viewer's dims, captures the current pane state as a single
 *     `scrollback` snapshot, and starts forwarding live output/event/state
 *     fan-out. No byte-log replay — TUI repaints in the log confuse xterm.
 *   - Inputs from the client go through AgentRuntime's serialized queue.
 *
 * The hub is a singleton (same bootstrap that owns the supervisor).
 */

import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '$shared/protocol';
import { PROTOCOL_VERSION } from '$shared/protocol';
import { resolveSession, SESSION_COOKIE } from '../auth/session.js';
import { getSupervisor } from '../bootstrap.js';
import { Tmux } from '../tmux/TmuxSession.js';
import type { AgentRuntime } from '../agents/AgentRuntime.js';
import type { Cookies } from '@sveltejs/kit';

interface Subscription {
  agentId: string;
  runtime: AgentRuntime;
  offOutput: () => void;
  offEvent: () => void;
  offState: () => void;
}

class HubClient {
  private subs = new Map<string, Subscription>();

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
        this.handleSubscribe(msg.agentId, msg.cols, msg.rows);
        break;
      case 'unsubscribe_agent':
        this.handleUnsubscribe(msg.agentId);
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
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  private handleSubscribe(agentId: string, cols?: number, rows?: number): void {
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

    // Reconnect = (optional) resize tmux to the viewer's xterm dims → tiny
    // fence so the pane finishes repainting → capture-pane snapshot. The
    // client will `term.reset()` before applying this, so we never need to
    // replay the raw byte log (which for TUI agents contains every
    // intermediate repaint pass and renders as garbage in a virgin xterm).
    void this.sendReconnectSnapshot(runtime, agentId, cols, rows);

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

    runtime.on('output', onOutput);
    runtime.on('event', onEvent);
    runtime.on('state', onState);

    this.subs.set(agentId, {
      agentId,
      runtime,
      offOutput: () => runtime.off('output', onOutput),
      offEvent: () => runtime.off('event', onEvent),
      offState: () => runtime.off('state', onState)
    });
  }

  /**
   * Resize-then-capture reconnect snapshot. Tmux's `resize-window` command
   * returns synchronously but the pane's repaint is asynchronous, so we
   * insert a tiny fence (~25ms) before capture; that's well under the
   * round-trip latency the client already absorbs on reconnect and reliably
   * lets Claude Code / Codex / Gemini finish their redraw. Failures are
   * swallowed (agent may be dying) but we still try to capture so the
   * viewer at least sees something.
   *
   * The capture strategy is adapter-driven (`runtime.scrollbackMode`):
   *
   *   - `'visible'` (TUI CLIs like Claude Code) → `capture-pane -S 0`,
   *     i.e. only what's on screen right now. Tmux's scrollback for those
   *     agents is a stack of redraw ghosts that no dedup can fully clean
   *     up — in particular Claude Code's Ctrl-O expand/collapse widget
   *     produces byte-unequal variants that slip past
   *     `collapseRepeatingTailBlocks`. Dropping scrollback on reopen is
   *     the right answer for them.
   *
   *   - `'history'` (line-based CLIs like the shell smoke adapter) →
   *     `capture-pane -S -500` piped through `collapseRepeatingTailBlocks`,
   *     giving real session backlog on reopen.
   */
  private async sendReconnectSnapshot(
    runtime: AgentRuntime,
    agentId: string,
    cols?: number,
    rows?: number
  ): Promise<void> {
    if (
      typeof cols === 'number' &&
      typeof rows === 'number' &&
      Number.isFinite(cols) &&
      Number.isFinite(rows) &&
      cols >= 1 &&
      rows >= 1
    ) {
      try {
        await runtime.resize(cols, rows);
      } catch {
        // Resize failed (session gone, tmux refused) — continue to capture
        // anyway; capture itself is tolerant of missing sessions.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    const mode = runtime.scrollbackMode;
    const startLine = mode === 'history' ? -500 : 0;
    const raw = await Tmux.capturePane(runtime.tmuxSession, startLine).catch(() => '');
    if (!raw) return;
    // Dedup only applies to the `'history'` path — the `'visible'` capture
    // is one screenful of current state, no repeating banners to fold.
    const snapshot = mode === 'history' ? collapseRepeatingTailBlocks(raw) : raw;

    // tmux capture-pane separates lines with bare `\n` (it reconstructs them
    // from the grid), but the client xterm runs with `convertEol: false` so
    // live PTY bytes — which already carry `\r\n` — aren't mangled. Feeding
    // bare `\n` into that xterm produces stairstep output (each new line
    // starts at the cursor's current column). Normalize to CRLF here so the
    // snapshot renders the same way as the live stream.
    const normalized = snapshot.replace(/\r?\n/g, '\r\n');
    this.send({
      type: 'scrollback',
      agentId,
      chunks: [{ seq: 0, b64: Buffer.from(normalized).toString('base64') }]
    });
  }

  private handleUnsubscribe(agentId: string): void {
    const sub = this.subs.get(agentId);
    if (!sub) return;
    sub.offOutput();
    sub.offEvent();
    sub.offState();
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

  private cleanup(): void {
    for (const id of Array.from(this.subs.keys())) {
      this.handleUnsubscribe(id);
    }
  }
}

export class WsHub {
  private clients = new Set<HubClient>();

  attach(ws: WebSocket, req: IncomingMessage): void {
    // Cheap cookie-based auth: parse the Cookie header and resolve via the
    // same helper routes use. Upgrade requests always carry the request
    // cookie header so this works identically in dev and prod.
    const cookieHeader = req.headers.cookie ?? '';
    const sid = extractCookie(cookieHeader, SESSION_COOKIE);
    if (!sid) {
      ws.close(4401, 'unauthenticated');
      return;
    }

    // Build a minimal Cookies-like shim that resolveSession accepts.
    const shim: Pick<Cookies, 'get'> = {
      get: (name: string): string | undefined =>
        name === SESSION_COOKIE ? sid : extractCookie(cookieHeader, name)
    };
    const { user } = resolveSession(shim as Cookies);
    if (!user) {
      ws.close(4401, 'session expired');
      return;
    }

    const client = new HubClient(ws, user.id);
    this.clients.add(client);
    ws.on('close', () => this.clients.delete(client));
  }
}

function extractCookie(header: string, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

let _hub: WsHub | null = null;
export function getWsHub(): WsHub {
  if (!_hub) _hub = new WsHub();
  return _hub;
}

/**
 * Greedy tail-block dedup for `tmux capture-pane` output.
 *
 * Some CLIs (notably Claude Code, which doesn't use the alt-screen buffer)
 * redraw their whole UI on every streaming tick. Each redraw scrolls the
 * previous version up into tmux's scrollback history, so capturing ~500
 * lines back gives you N identical copies of the same conversation stacked
 * on top of each other. This collapses them back to a single copy without
 * needing to know anything about the specific CLI.
 *
 * Algorithm:
 *   1. Split on `\n`.
 *   2. Walk from the end, find the largest `k ≥ 2` where the last k lines
 *      equal the preceding k lines.
 *   3. If found, splice one copy out and go back to step 2.
 *   4. Stop when no such k exists.
 *
 * `k ≥ 2` is deliberate: a single repeated line is ambiguous (legitimate
 * duplicate shell output vs spinner tail), but any block of 2+ identical
 * consecutive lines repeating tail-to-tail is almost always redraw noise.
 *
 * Complexity is O(n²) in the number of lines (~500 here), which is fine.
 */
export function collapseRepeatingTailBlocks(text: string): string {
  const lines = text.split('\n');
  let progressed = true;
  while (progressed) {
    progressed = false;
    const n = lines.length;
    const maxK = Math.floor(n / 2);
    for (let k = maxK; k >= 2; k--) {
      let match = true;
      for (let i = 0; i < k; i++) {
        if (lines[n - 2 * k + i] !== lines[n - k + i]) {
          match = false;
          break;
        }
      }
      if (match) {
        lines.splice(n - 2 * k, k);
        progressed = true;
        break;
      }
    }
  }
  return lines.join('\n');
}

