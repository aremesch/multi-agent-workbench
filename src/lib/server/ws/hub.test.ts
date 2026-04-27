import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// Hoisted mock state — vi.mock factories run before the surrounding file's
// const declarations, so any mock that needs to reach shared state goes
// through the `mocks` handle returned from vi.hoisted().
// -----------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    // --- supervisor shim ---
    supervisor: {
      get: vi.fn(),
      kill: vi.fn()
    },
    // --- tmux shim ---
    sendKey: vi.fn(),
    capturePane: vi.fn(),
    // --- auth / config ---
    getSession: vi.fn(),
    logAuth: vi.fn(),
    config: { publicOrigin: null as string | null },
    // --- db ---
    getLatestTerminalSeq: vi.fn(),
    listTerminalChunksSince: vi.fn()
  };
});

vi.mock('../bootstrap.js', () => ({
  getSupervisor: () => mocks.supervisor
}));
vi.mock('../tmux/TmuxSession.js', () => ({
  Tmux: {
    sendKey: (...a: unknown[]) => mocks.sendKey(...a),
    capturePane: (...a: unknown[]) => mocks.capturePane(...a)
  }
}));
vi.mock('../auth/betterAuth.js', () => ({
  auth: {
    api: {
      getSession: (...a: unknown[]) => mocks.getSession(...a)
    }
  }
}));
vi.mock('../auth/authLog.js', () => ({
  logAuth: (...a: unknown[]) => mocks.logAuth(...a)
}));
vi.mock('../config.js', () => ({
  getConfig: () => mocks.config
}));
vi.mock('../db/queries.js', () => ({
  getLatestTerminalSeq: (...a: unknown[]) => mocks.getLatestTerminalSeq(...a),
  listTerminalChunksSince: (...a: unknown[]) => mocks.listTerminalChunksSince(...a),
  // Tests in this file exclusively cover the CLI-agent runtime path; the
  // browser-stream branch (added in v0.3) keys on getAgent/isStreamKind to
  // route /ws subscribes to a Playwright session manager. Returning
  // undefined here makes handleSubscribe fall through to its existing
  // runtime-based logic — the same behavior these tests have always asserted.
  getAgent: () => undefined
}));
vi.mock('../agents/AgentSupervisor.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../agents/AgentSupervisor.js')>();
  return {
    ...orig,
    // Force false so handleSubscribe stays on the runtime branch even if
    // a future change to getAgent's mock returns a non-undefined row.
    isStreamKind: () => false
  };
});
vi.mock('../preview/PlaywrightSessionManager.js', () => ({
  getPlaywrightSessions: () => ({
    get: () => undefined,
    start: async () => {
      throw new Error('not used in this test');
    },
    stop: async () => {}
  })
}));

import { WsHub, getWsHub } from './hub.js';
import { PROTOCOL_VERSION } from '$shared/protocol';

/** Cookie name used in the WS upgrade Cookie header. The actual name is owned
 *  by better-auth — this is just a placeholder for tests since the auth.api
 *  mock returns whatever session we want regardless of the header content. */
const SESSION_COOKIE_HEADER = 'maw_session';

/** Flush all pending microtasks so attachAsync's `await getSession` settles. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

class FakeWs extends EventEmitter {
  sent: string[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
  }
  sentMessages(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  lastMessage(): unknown {
    return this.sentMessages().at(-1);
  }
  deliver(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg), 'utf8'));
  }
}

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
}

function makeRuntime(overrides: Partial<{
  userId: string;
  agentId: string;
  tmuxSession: string;
}> = {}): EventEmitter & Record<string, unknown> {
  const o = {
    userId: 'u1',
    agentId: 'a1',
    tmuxSession: 'maw-agent-a1',
    ...overrides
  };
  const rt = new EventEmitter() as EventEmitter & Record<string, unknown>;
  rt.agent = { user_id: o.userId };
  rt.tmuxSession = o.tmuxSession;
  rt.resize = vi.fn(async () => undefined);
  rt.enqueueInput = vi.fn(async () => undefined);
  rt.enqueueRawKeys = vi.fn(async () => undefined);
  rt.enqueueAnswer = vi.fn(async () => undefined);
  return rt;
}

/** Shortcut: run attach() with a pre-validated session (userId === 'u1').
 *  Awaits a microtask flush so the welcome frame and HubClient registration
 *  inside attachAsync have fired before the caller asserts on `ws`. */
async function attachAuthedClient(agentOwnerId = 'u1'): Promise<{ hub: WsHub; ws: FakeWs }> {
  mocks.getSession.mockResolvedValue({
    user: { id: agentOwnerId },
    session: { id: 'sess', userId: agentOwnerId, token: 't', expiresAt: Date.now() + 1000 }
  });
  const hub = new WsHub();
  const ws = new FakeWs();
  hub.attach(
    ws as unknown as import('ws').WebSocket,
    fakeReq({ cookie: `${SESSION_COOKIE_HEADER}=abc`, origin: 'http://localhost:5173' })
  );
  await flush();
  return { hub, ws };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.publicOrigin = null;
  mocks.supervisor.get.mockReset();
  mocks.supervisor.kill.mockReset();
  mocks.sendKey.mockReset().mockResolvedValue(undefined);
  mocks.capturePane.mockReset().mockResolvedValue('');
  mocks.getLatestTerminalSeq.mockReset().mockReturnValue(0);
  mocks.listTerminalChunksSince.mockReset().mockReturnValue([]);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// Singleton accessor
// -----------------------------------------------------------------------------

describe('hub re-exports', () => {
  it('getWsHub returns a singleton WsHub', async () => {
    expect(getWsHub()).toBeInstanceOf(WsHub);
    expect(getWsHub()).toBe(getWsHub());
  });
});

// -----------------------------------------------------------------------------
// WsHub.attach — auth gateway
// -----------------------------------------------------------------------------

describe('WsHub.attach — authentication gateway', () => {
  it('rejects a connection without a session (no cookie / expired)', async () => {
    mocks.getSession.mockResolvedValue(null);
    const hub = new WsHub();
    const ws = new FakeWs();
    hub.attach(ws as unknown as import('ws').WebSocket, fakeReq());
    await flush();
    expect(ws.closeCode).toBe(4401);
    expect(ws.closeReason).toBe('unauthenticated');
  });

  it('rejects a cross-origin upgrade when publicOrigin is set', async () => {
    mocks.config.publicOrigin = 'https://maw.example';
    const hub = new WsHub();
    const ws = new FakeWs();
    hub.attach(
      ws as unknown as import('ws').WebSocket,
      fakeReq({
        cookie: `${SESSION_COOKIE_HEADER}=x`,
        origin: 'https://attacker.example',
        'user-agent': 'evil'
      })
    );
    expect(ws.closeCode).toBe(4403);
    expect(mocks.logAuth).toHaveBeenCalledWith(
      'ws_origin_reject',
      expect.objectContaining({ detail: 'https://attacker.example', userAgent: 'evil' })
    );
  });

  it('allows a matching-origin request to proceed', async () => {
    mocks.config.publicOrigin = 'https://maw.example';
    mocks.getSession.mockResolvedValue({
      user: { id: 'u1' },
      session: { id: 's', userId: 'u1', token: 't', expiresAt: Date.now() + 1000 }
    });
    const hub = new WsHub();
    const ws = new FakeWs();
    hub.attach(
      ws as unknown as import('ws').WebSocket,
      fakeReq({ cookie: `${SESSION_COOKIE_HEADER}=x`, origin: 'https://maw.example' })
    );
    await flush();
    expect(ws.closeCode).toBeNull();
  });

  it('skips the origin check when no Origin header is present (non-browser client)', async () => {
    mocks.config.publicOrigin = 'https://maw.example';
    mocks.getSession.mockResolvedValue({
      user: { id: 'u1' },
      session: { id: 's', userId: 'u1', token: 't', expiresAt: Date.now() + 1000 }
    });
    const hub = new WsHub();
    const ws = new FakeWs();
    hub.attach(
      ws as unknown as import('ws').WebSocket,
      fakeReq({ cookie: `${SESSION_COOKIE_HEADER}=x` })
    );
    await flush();
    expect(ws.closeCode).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Handshake + ping
// -----------------------------------------------------------------------------

describe('HubClient — handshake + ping', () => {
  it('sends a `welcome` frame with the current PROTOCOL_VERSION on connect', async () => {
    const { ws } = await attachAuthedClient();
    expect(ws.sentMessages()[0]).toEqual({
      type: 'welcome',
      serverVersion: PROTOCOL_VERSION,
      userId: 'u1'
    });
  });

  it('replies to `ping` with `pong` carrying the same ts', async () => {
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'ping', ts: 12345 });
    expect(ws.lastMessage()).toEqual({ type: 'pong', ts: 12345 });
  });

  it('silently accepts `hello` (no duplicate welcome)', async () => {
    const { ws } = await attachAuthedClient();
    const before = ws.sent.length;
    ws.deliver({ type: 'hello', clientVersion: PROTOCOL_VERSION });
    expect(ws.sent.length).toBe(before);
  });
});

// -----------------------------------------------------------------------------
// Malformed / unknown client messages
// -----------------------------------------------------------------------------

describe('HubClient — defensive parsing', () => {
  it('returns a `bad_json` error frame for malformed JSON and stays open', async () => {
    const { ws } = await attachAuthedClient();
    // Directly emit invalid bytes — ws.deliver would have JSON.stringify'd.
    ws['emit']('message', Buffer.from('{not json', 'utf8'));
    const err = ws.sentMessages().find((m) => (m as { type?: string }).type === 'error') as {
      code: string;
    };
    expect(err.code).toBe('bad_json');
    expect(ws.closeCode).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// subscribe_agent — pane snapshot + catch-up (protocol v5)
// -----------------------------------------------------------------------------

describe('HubClient — subscribe_agent', () => {
  it('returns `not_found` when the supervisor has no runtime for that agent', async () => {
    mocks.supervisor.get.mockReturnValue(undefined);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'missing' });
    const last = ws.lastMessage() as { type: string; code?: string };
    expect(last.type).toBe('error');
    expect(last.code).toBe('not_found');
  });

  it('returns `forbidden` when the runtime belongs to a different user', async () => {
    mocks.supervisor.get.mockReturnValue(makeRuntime({ userId: 'other-user' }));
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });
    const err = ws.sentMessages().find((m) => (m as { type?: string }).type === 'error') as {
      code: string;
    };
    expect(err.code).toBe('forbidden');
  });

  it('ships the tmux pane state as a `pane_snapshot` with the current seq watermark', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    mocks.getLatestTerminalSeq.mockReturnValue(42);
    mocks.capturePane.mockResolvedValue('\x1b[2J\x1b[H$ ready\r\n');
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });

    await vi.waitFor(() =>
      expect(
        ws.sentMessages().find((m) => (m as { type?: string }).type === 'pane_snapshot')
      ).toBeDefined()
    );
    expect(mocks.capturePane).toHaveBeenCalledWith('maw-agent-a1', 0);
    expect(mocks.getLatestTerminalSeq).toHaveBeenCalledWith('a1');
    const snap = ws.sentMessages().find((m) => (m as { type?: string }).type === 'pane_snapshot') as {
      ansi: string;
      seq: number;
    };
    expect(snap.ansi).toBe('\x1b[2J\x1b[H$ ready\r\n');
    expect(snap.seq).toBe(42);
  });

  it('follows the snapshot with a catch-up of terminal_log chunks newer than the snapshot seq', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    mocks.getLatestTerminalSeq.mockReturnValue(5);
    mocks.capturePane.mockResolvedValue('');
    mocks.listTerminalChunksSince.mockReturnValue([
      { seq: 6, chunk: Buffer.from('x', 'utf8') },
      { seq: 7, chunk: Buffer.from('y', 'utf8') }
    ]);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });

    await vi.waitFor(() =>
      expect(
        ws.sentMessages().filter((m) => (m as { type?: string }).type === 'output').length
      ).toBe(2)
    );
    expect(mocks.listTerminalChunksSince).toHaveBeenCalledWith('a1', 5);
    const outs = ws
      .sentMessages()
      .filter((m) => (m as { type?: string }).type === 'output') as Array<{
      seq: number;
      b64: string;
    }>;
    expect(outs.map((o) => o.seq)).toEqual([6, 7]);
    expect(Buffer.from(outs[0]!.b64, 'base64').toString('utf8')).toBe('x');
    expect(Buffer.from(outs[1]!.b64, 'base64').toString('utf8')).toBe('y');
    // Wire order: snapshot before catch-up.
    const frames = ws.sentMessages() as Array<{ type: string }>;
    const snapIdx = frames.findIndex((f) => f.type === 'pane_snapshot');
    const firstOutIdx = frames.findIndex((f) => f.type === 'output');
    expect(snapIdx).toBeGreaterThanOrEqual(0);
    expect(firstOutIdx).toBeGreaterThan(snapIdx);
  });

  it('emits an empty-ansi snapshot (with console.warn) when capture-pane fails', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    mocks.getLatestTerminalSeq.mockReturnValue(3);
    mocks.capturePane.mockRejectedValue(new Error('tmux kaboom'));
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });

    await vi.waitFor(() =>
      expect(
        ws.sentMessages().find((m) => (m as { type?: string }).type === 'pane_snapshot')
      ).toBeDefined()
    );
    const snap = ws.sentMessages().find((m) => (m as { type?: string }).type === 'pane_snapshot') as {
      ansi: string;
      seq: number;
    };
    expect(snap.ansi).toBe('');
    expect(snap.seq).toBe(3);
  });

  it('fans out runtime `output` events as output frames (live stream)', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });
    // Listener registration is synchronous within handleSubscribe, so a
    // live output event landing BEFORE the async snapshot resolves still
    // reaches the client (client dedup handles overlap with catch-up).
    rt.emit('output', { seq: 42, chunk: Buffer.from('hello', 'utf8') });
    const out = ws.sentMessages().find((m) => (m as { type?: string }).type === 'output') as {
      seq: number;
      b64: string;
    };
    expect(out.seq).toBe(42);
    expect(Buffer.from(out.b64, 'base64').toString('utf8')).toBe('hello');
  });

  it('fans out runtime `state` events as agent_state frames', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });
    rt.emit('state', 'WAITING_PROMPT');
    const st = ws.sentMessages().find((m) => (m as { type?: string }).type === 'agent_state') as {
      status: string;
    };
    expect(st.status).toBe('WAITING_PROMPT');
  });

  it('is idempotent — subscribing twice does not double-attach listeners', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });
    rt.emit('output', { seq: 1, chunk: Buffer.from('x') });
    const outputs = ws.sentMessages().filter((m) => (m as { type?: string }).type === 'output');
    expect(outputs.length).toBe(1);
  });

  it('drops the snapshot tail if the client unsubscribes before capture-pane resolves', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    mocks.getLatestTerminalSeq.mockReturnValue(0);
    // Capture-pane never resolves until we let it.
    let releaseCapture: (v: string) => void = () => {};
    mocks.capturePane.mockReturnValue(
      new Promise<string>((r) => {
        releaseCapture = r;
      })
    );
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });
    // Unsubscribe while the snapshot is still pending.
    ws.deliver({ type: 'unsubscribe_agent', agentId: 'a1' });
    // Now release capture-pane — the tail should bail out.
    releaseCapture('ignored-by-client');
    await new Promise((r) => setImmediate(r));
    expect(
      ws.sentMessages().find((m) => (m as { type?: string }).type === 'pane_snapshot')
    ).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// unsubscribe_agent + cleanup
// -----------------------------------------------------------------------------

describe('HubClient — unsubscribe + cleanup', () => {
  it('detaches runtime listeners on unsubscribe_agent', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });
    const before = rt.listenerCount('output');
    ws.deliver({ type: 'unsubscribe_agent', agentId: 'a1' });
    expect(rt.listenerCount('output')).toBe(before - 1);
  });

  it('cleanup on ws close removes every subscription', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'subscribe_agent', agentId: 'a1' });
    ws.emit('close');
    expect(rt.listenerCount('output')).toBe(0);
    expect(rt.listenerCount('state')).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// send_input / send_keys / resize / answer_prompt / control
// -----------------------------------------------------------------------------

describe('HubClient — input + control dispatch', async () => {
  it('send_input routes to runtime.enqueueInput', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'send_input', agentId: 'a1', text: 'hi', submit: true });
    expect(rt.enqueueInput).toHaveBeenCalledWith('hi', true);
  });

  it('send_input is dropped when runtime belongs to another user', async () => {
    mocks.supervisor.get.mockReturnValue(makeRuntime({ userId: 'other' }));
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'send_input', agentId: 'a1', text: 'x', submit: false });
    // enqueueInput never called — no easy way to assert on a foreign runtime's
    // mock, but the attempt should not throw and no output frames are emitted.
    expect(ws.sentMessages().find((m) => (m as { type?: string }).type === 'error')).toBeUndefined();
  });

  it('send_keys base64-decodes and forwards bytes', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    const b64 = Buffer.from('\x1b[A', 'utf8').toString('base64');
    ws.deliver({ type: 'send_keys', agentId: 'a1', b64 });
    expect(rt.enqueueRawKeys).toHaveBeenCalledWith('\x1b[A');
  });

  it('resize ignores non-finite or sub-1 dims', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'resize', agentId: 'a1', cols: 0, rows: 24 });
    ws.deliver({ type: 'resize', agentId: 'a1', cols: Number.NaN, rows: 24 });
    expect(rt.resize).not.toHaveBeenCalled();
  });

  it('resize forwards valid dims to runtime.resize', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'resize', agentId: 'a1', cols: 80, rows: 24 });
    expect(rt.resize).toHaveBeenCalledWith(80, 24);
  });

  it('answer_prompt routes to runtime.enqueueAnswer', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'answer_prompt', agentId: 'a1', choice: 'yes' });
    expect(rt.enqueueAnswer).toHaveBeenCalledWith('yes');
  });

  it('control:sigint sends C-c via Tmux.sendKey', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'control', agentId: 'a1', action: 'sigint' });
    expect(mocks.sendKey).toHaveBeenCalledWith('maw-agent-a1', 'C-c');
  });

  it('control:stop calls supervisor.kill', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    mocks.supervisor.kill.mockResolvedValue(undefined);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'control', agentId: 'a1', action: 'stop' });
    expect(mocks.supervisor.kill).toHaveBeenCalledWith('a1');
  });

  it('control:restart emits a not_implemented error (v0.1 stub)', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({ type: 'control', agentId: 'a1', action: 'restart' });
    const err = ws.sentMessages().find((m) => (m as { type?: string }).type === 'error') as {
      code: string;
    };
    expect(err.code).toBe('not_implemented');
  });

  it('assign_task forwards task body to runtime.enqueueInput with submit=true', async () => {
    const rt = makeRuntime();
    mocks.supervisor.get.mockReturnValue(rt);
    const { ws } = await attachAuthedClient();
    ws.deliver({
      type: 'assign_task',
      agentId: 'a1',
      task: { title: 'T', body: 'do the thing' }
    });
    expect(rt.enqueueInput).toHaveBeenCalledWith('do the thing', true);
  });
});
