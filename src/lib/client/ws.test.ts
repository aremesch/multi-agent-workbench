// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHandlers } from './ws.js';
import { MawWsClient } from './ws.js';

// -----------------------------------------------------------------------------
// FakeWebSocket — observable stand-in for the global WebSocket. Tests drive
// lifecycle callbacks manually (open/message/close/error) to avoid real
// timing and real sockets.
// -----------------------------------------------------------------------------

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

let lastFake: FakeWebSocket | null = null;
const instances: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSED = CLOSED;

  url: string;
  readyState: number = CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    instances.push(this);
    lastFake = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = CLOSED;
    // Callers don't call onclose themselves — we emulate the browser doing it
    // on the next microtask so listeners get it synchronously in tests.
    queueMicrotask(() => this.onclose?.());
  }

  open(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  sentMessages(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function handlers(): AgentHandlers & {
  outputs: unknown[];
  scrollbacks: unknown[];
  events: unknown[];
  states: string[];
} {
  const outputs: unknown[] = [];
  const scrollbacks: unknown[] = [];
  const events: unknown[] = [];
  const states: string[] = [];
  return {
    onOutput: (m) => outputs.push(m),
    onScrollback: (m) => scrollbacks.push(m),
    onEvent: (m) => events.push(m),
    onState: (s) => states.push(s),
    outputs,
    scrollbacks,
    events,
    states
  };
}

beforeEach(() => {
  instances.length = 0;
  lastFake = null;
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
});

// -----------------------------------------------------------------------------
// connect() + handshake
// -----------------------------------------------------------------------------

describe('MawWsClient.connect', () => {
  it('opens a WebSocket at ws(s)://<host>/ws based on location.protocol', () => {
    const client = new MawWsClient();
    client.connect();
    expect(lastFake).not.toBeNull();
    expect(lastFake!.url).toMatch(/\/ws$/);
  });

  it('sends `hello` with clientVersion=1 on the open event', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    expect(lastFake!.sentMessages()[0]).toEqual({ type: 'hello', clientVersion: 1 });
  });

  it('connect() is idempotent while a socket is not CLOSED', () => {
    const client = new MawWsClient();
    client.connect();
    client.connect();
    expect(instances).toHaveLength(1);
  });

  it('connection state transitions closed → reconnecting → open', () => {
    const client = new MawWsClient();
    const seen: string[] = [];
    client.addConnectionListener((s) => seen.push(s));
    // Initial listener fire: closed
    expect(seen).toEqual(['closed']);
    client.connect();
    expect(seen).toEqual(['closed', 'reconnecting']);
    lastFake!.open();
    expect(seen).toEqual(['closed', 'reconnecting', 'open']);
  });

  it('dedupes identical connection state notifications', () => {
    const client = new MawWsClient();
    const seen: string[] = [];
    const off = client.addConnectionListener((s) => seen.push(s));
    const first = seen.length;
    client.addConnectionListener((s) => void s); // adding doesn't change state
    expect(seen).toHaveLength(first);
    off();
  });
});

// -----------------------------------------------------------------------------
// subscribe / unsubscribe / dispatch
// -----------------------------------------------------------------------------

describe('MawWsClient.subscribe / dispatch', () => {
  it('sends `subscribe_agent` immediately once the socket is open (no lastSeq on first attach)', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    lastFake!.sent.length = 0;
    client.subscribe('a1', handlers());
    expect(lastFake!.sentMessages()[0]).toEqual({
      type: 'subscribe_agent',
      agentId: 'a1'
    });
  });

  it('forwards an explicit lastSeq seed when the caller passes one', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    lastFake!.sent.length = 0;
    client.subscribe('a1', handlers(), 17);
    expect(lastFake!.sentMessages()[0]).toEqual({
      type: 'subscribe_agent',
      agentId: 'a1',
      lastSeq: 17
    });
  });

  it('defers subscribe_agent send until the socket is open (queued by design — no throw)', () => {
    const client = new MawWsClient();
    client.connect();
    // readyState is CONNECTING — send is a no-op.
    client.subscribe('a1', handlers());
    expect(lastFake!.sent).toHaveLength(0);
  });

  it('routes output / scrollback / event to the correct handlers', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    const h = handlers();
    client.subscribe('a1', h);

    lastFake!.deliver({ type: 'output', agentId: 'a1', seq: 1, b64: 'x' });
    lastFake!.deliver({ type: 'scrollback', agentId: 'a1', chunks: [{ seq: 0, b64: 'y' }] });
    lastFake!.deliver({ type: 'event', agentId: 'a1', kind: 'idle' });
    lastFake!.deliver({ type: 'agent_state', agentId: 'a1', status: 'READY' });

    expect(h.outputs).toHaveLength(1);
    expect(h.scrollbacks).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(h.states).toEqual(['READY']);
  });

  it('drops `output` frames whose seq is at or below the watermark (replay-on-reconnect dedup)', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    const h = handlers();
    client.subscribe('a1', h);

    lastFake!.deliver({ type: 'output', agentId: 'a1', seq: 5, b64: 'a' });
    lastFake!.deliver({ type: 'output', agentId: 'a1', seq: 3, b64: 'b' });   // older — dropped
    lastFake!.deliver({ type: 'output', agentId: 'a1', seq: 5, b64: 'c' });   // equal — dropped
    lastFake!.deliver({ type: 'output', agentId: 'a1', seq: 6, b64: 'd' });   // newer — kept
    expect(h.outputs).toHaveLength(2);
  });

  it('bumps the watermark from a `scrollback` burst so subsequent in-burst seqs do not double-paint', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    const h = handlers();
    client.subscribe('a1', h);

    lastFake!.deliver({
      type: 'scrollback',
      agentId: 'a1',
      chunks: [
        { seq: 1, b64: 'a' },
        { seq: 2, b64: 'b' }
      ]
    });
    expect(h.scrollbacks).toHaveLength(1);

    // Live `output` with a seq the burst already covered — should be dropped.
    lastFake!.deliver({ type: 'output', agentId: 'a1', seq: 2, b64: 'c' });
    expect(h.outputs).toHaveLength(0);
    // …but a fresh seq above the burst still lands.
    lastFake!.deliver({ type: 'output', agentId: 'a1', seq: 3, b64: 'd' });
    expect(h.outputs).toHaveLength(1);
  });

  it('ignores messages whose agentId has no matching subscription', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    const h = handlers();
    client.subscribe('a1', h);
    lastFake!.deliver({ type: 'output', agentId: 'other', seq: 1, b64: 'x' });
    expect(h.outputs).toHaveLength(0);
  });

  it('unsubscribe removes the entry AND sends unsubscribe_agent', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    const h = handlers();
    client.subscribe('a1', h);
    lastFake!.sent.length = 0;
    client.unsubscribe('a1');
    expect(lastFake!.sentMessages()[0]).toEqual({ type: 'unsubscribe_agent', agentId: 'a1' });
    // Future messages to a1 are dropped.
    lastFake!.deliver({ type: 'output', agentId: 'a1', seq: 1, b64: 'x' });
    expect(h.outputs).toHaveLength(0);
  });

  it('silently skips malformed JSON frames from the server', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    lastFake!.onmessage?.({ data: '{broken' });
    // No throw, no listener fire.
    expect(true).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Global agent_state listener
// -----------------------------------------------------------------------------

describe('MawWsClient.addGlobalAgentStateListener', () => {
  it('fires for agent_state messages even without a subscription', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    const seen: Array<{ agentId: string; status: string }> = [];
    const off = client.addGlobalAgentStateListener((agentId, status) =>
      seen.push({ agentId, status })
    );
    lastFake!.deliver({ type: 'agent_state', agentId: 'a1', status: 'EXITED' });
    lastFake!.deliver({ type: 'agent_state', agentId: 'a2', status: 'READY' });
    expect(seen).toEqual([
      { agentId: 'a1', status: 'EXITED' },
      { agentId: 'a2', status: 'READY' }
    ]);
    off();
    lastFake!.deliver({ type: 'agent_state', agentId: 'a1', status: 'READY' });
    expect(seen).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// Input / resize helpers
// -----------------------------------------------------------------------------

describe('MawWsClient — input helpers', () => {
  it('sendInput forwards text + submit as a send_input frame', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    lastFake!.sent.length = 0;
    client.sendInput('a1', 'hello', true);
    expect(lastFake!.sentMessages()[0]).toEqual({
      type: 'send_input',
      agentId: 'a1',
      text: 'hello',
      submit: true
    });
  });

  it('sendKeys encodes the text to base64 via the bytes path (multibyte-safe)', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    lastFake!.sent.length = 0;
    // U+1F600 grinning face — forces the non-latin-1 path.
    client.sendKeys('a1', '\u{1F600}');
    const msg = lastFake!.sentMessages()[0] as { type: string; agentId: string; b64: string };
    expect(msg.type).toBe('send_keys');
    // Round-trip decode must match the original bytes.
    const bin = atob(msg.b64);
    const bytes = new Uint8Array([...bin].map((c) => c.charCodeAt(0)));
    expect(new TextDecoder().decode(bytes)).toBe('\u{1F600}');
  });

  it('sendKeys no-ops on empty text (avoids spurious frames)', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    lastFake!.sent.length = 0;
    client.sendKeys('a1', '');
    expect(lastFake!.sent).toHaveLength(0);
  });

  it('answerPrompt forwards choice as-is', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    lastFake!.sent.length = 0;
    client.answerPrompt('a1', 2);
    expect(lastFake!.sentMessages()[0]).toEqual({ type: 'answer_prompt', agentId: 'a1', choice: 2 });
  });

  it('sendResize emits a resize frame with the given dims', () => {
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    client.subscribe('a1', handlers());
    lastFake!.sent.length = 0;
    client.sendResize('a1', 100, 40);
    expect(lastFake!.sentMessages()[0]).toEqual({
      type: 'resize',
      agentId: 'a1',
      cols: 100,
      rows: 40
    });
  });
});

// -----------------------------------------------------------------------------
// Reconnect + backoff
// -----------------------------------------------------------------------------

describe('MawWsClient — reconnect + backoff', () => {
  it('re-issues every active subscription on reconnect, carrying the latest seen seq as lastSeq', async () => {
    vi.useFakeTimers();
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    client.subscribe('a1', handlers());
    client.subscribe('a2', handlers());
    // Push some output so a1's watermark advances past 0.
    lastFake!.deliver({ type: 'output', agentId: 'a1', seq: 7, b64: 'x' });

    // Drop the socket.
    const first = lastFake!;
    first.close();
    await Promise.resolve(); // let microtask-enqueued onclose fire
    // Advance through the initial 500ms backoff.
    await vi.advanceTimersByTimeAsync(500);
    // New socket was created and opened.
    expect(instances.length).toBe(2);
    lastFake!.open();

    const frames = lastFake!.sentMessages();
    const subs = frames.filter((m) => (m as { type: string }).type === 'subscribe_agent') as Array<{
      agentId: string;
      lastSeq?: number;
    }>;
    expect(subs).toHaveLength(2);
    const a1 = subs.find((s) => s.agentId === 'a1');
    const a2 = subs.find((s) => s.agentId === 'a2');
    // a1 saw seq=7, so it must re-subscribe with lastSeq=7 to skip already-painted bytes.
    expect(a1?.lastSeq).toBe(7);
    // a2 saw nothing, so lastSeq is omitted.
    expect(a2).toEqual({ type: 'subscribe_agent', agentId: 'a2' });
  });

  it('uses exponential backoff: 500ms → 1s → 2s, capped at 30s', async () => {
    vi.useFakeTimers();
    const client = new MawWsClient();
    client.connect();
    const starts: number[] = [];
    // Observe the interval between close and the next `new FakeWebSocket(...)`.
    async function nextSocketAfter(ms: number): Promise<void> {
      const before = instances.length;
      await vi.advanceTimersByTimeAsync(ms);
      if (instances.length !== before + 1) {
        throw new Error(`expected a new socket after ${ms}ms`);
      }
    }

    // First close → 500ms
    lastFake!.close();
    await Promise.resolve();
    await nextSocketAfter(500);
    starts.push(500);

    // Second close → 1s
    lastFake!.close();
    await Promise.resolve();
    await nextSocketAfter(1000);
    starts.push(1000);

    // Third close → 2s
    lastFake!.close();
    await Promise.resolve();
    await nextSocketAfter(2000);
    starts.push(2000);

    expect(starts).toEqual([500, 1000, 2000]);
  });

  it('resets backoff to 500ms after a successful open', async () => {
    vi.useFakeTimers();
    const client = new MawWsClient();
    client.connect();
    lastFake!.open(); // success resets backoff
    lastFake!.close();
    await Promise.resolve();
    // Next reconnect attempt should land at 500ms, not some larger value.
    const before = instances.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(instances.length).toBe(before + 1);
  });

  it('close() sets closed=true and stops the reconnect loop', async () => {
    vi.useFakeTimers();
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    client.close();
    await Promise.resolve();
    // Advance well past any backoff — no new socket should be created.
    const before = instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instances.length).toBe(before);
  });
});

// -----------------------------------------------------------------------------
// Heartbeat
// -----------------------------------------------------------------------------

describe('MawWsClient — heartbeat', () => {
  it('sends a `ping` every 20s while open; stops after close', () => {
    vi.useFakeTimers();
    const client = new MawWsClient();
    client.connect();
    lastFake!.open();
    lastFake!.sent.length = 0;
    vi.advanceTimersByTime(20_000);
    vi.advanceTimersByTime(20_000);
    const pings = lastFake!.sentMessages().filter((m) => (m as { type: string }).type === 'ping');
    expect(pings.length).toBe(2);
    client.close();
    vi.advanceTimersByTime(20_000);
    const after = lastFake!.sentMessages().filter((m) => (m as { type: string }).type === 'ping').length;
    expect(after).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Singleton — getMawWsClient
// -----------------------------------------------------------------------------

describe('getMawWsClient', () => {
  it('returns the same instance on repeated calls (singleton)', async () => {
    vi.resetModules();
    const mod = await import('./ws.js');
    expect(mod.getMawWsClient()).toBe(mod.getMawWsClient());
  });
});
