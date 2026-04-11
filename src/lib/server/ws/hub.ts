/**
 * WebSocket hub — wires browser clients to AgentRuntimes.
 *
 * Wiring:
 *   - Every incoming ws connection is wrapped in a HubClient.
 *   - HubClient.subscribe(agentId) starts forwarding output/event/state
 *     fan-out from the AgentRuntime to this socket, and (if lastSeq is
 *     supplied) first replays missed chunks from terminal_log.
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
import { listTerminalChunksSince } from '../db/queries.js';
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
        this.handleSubscribe(msg.agentId, msg.lastSeq);
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

  private handleSubscribe(agentId: string, lastSeq?: number): void {
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

    // Replay missed chunks from the log.
    const baseSeq = lastSeq ?? 0;
    const missed = listTerminalChunksSince(agentId, baseSeq);
    if (missed.length > 0) {
      this.send({
        type: 'scrollback',
        agentId,
        chunks: missed.map((c) => ({ seq: c.seq, b64: c.chunk.toString('base64') }))
      });
    } else if (baseSeq === 0) {
      // Fresh viewer → seed with a tmux capture-pane snapshot so they see
      // history older than the terminal_log head.
      Tmux.capturePane(runtime.tmuxSession)
        .then((snapshot) => {
          if (!snapshot) return;
          this.send({
            type: 'scrollback',
            agentId,
            chunks: [{ seq: 0, b64: Buffer.from(snapshot).toString('base64') }]
          });
        })
        .catch(() => {});
    }

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
    for (const [id, _sub] of this.subs) {
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

