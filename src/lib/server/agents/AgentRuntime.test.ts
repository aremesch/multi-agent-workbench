/**
 * AgentRuntime unit tests — first coverage of the runtime layer.
 *
 * Verifies the two surfaces of AgentRuntime that the claude-code status
 * detection lifecycle relies on:
 *
 *   1. processEvent translates AdapterEvents into agents.status writes:
 *      ready → running, prompt_detected → waiting_input, task_done → idle,
 *      exited → exited. Plus the matching `'state'` event emission.
 *
 *   2. enqueueInput / enqueueRawKeys / enqueueAnswer route into Tmux with
 *      the correct argv ordering and serialise through a single promise
 *      chain so simultaneous keystrokes never interleave.
 *
 * Dependencies the runtime touches at construct time (`getLatestTerminalSeq`,
 * `new FifoStreamer(...)`) are mocked here. The DB module is replaced
 * wholesale via `vi.mock('../db/queries.js', ...)` so each query function
 * is a `vi.fn()` that the test inspects. Tmux is replaced the same way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEvent, CliAdapter } from '$shared/adapterTypes';
import type { AgentRow } from '../db/types.js';

// ---------------------------------------------------------------------------
// Mocks — `vi.mock` is hoisted, so the mock objects must come from
// `vi.hoisted()` to exist before the SUT's import-time `import` statements run.
// ---------------------------------------------------------------------------

const { dbMocks, tmuxMocks, pushMocks, MockFifoStreamer } = vi.hoisted(() => {
  class MockFifoStreamer {
    readonly path: string;
    constructor(opts: { fifoDir: string; agentId: string }) {
      this.path = `${opts.fifoDir}/fifo-${opts.agentId}`;
    }
    async create(): Promise<void> {
      /* no-op */
    }
    start(_cb: (chunk: Buffer) => void): void {
      /* no-op — tests never feed bytes through here */
    }
    async stop(): Promise<void> {
      /* no-op */
    }
  }

  return {
    dbMocks: {
      getTask: vi.fn(),
      insertAlert: vi.fn(),
      insertEvent: vi.fn(),
      insertTerminalChunk: vi.fn(),
      listRecentAlerts: vi.fn(() => [] as unknown[]),
      getUserSetting: vi.fn(() => null as string | null),
      updateAgentAttention: vi.fn(),
      updateAgentStatus: vi.fn(),
      getLatestTerminalSeq: vi.fn(() => 0)
    },
    tmuxMocks: {
      Tmux: {
        // Typed `vi.fn<...>()` so `mockImplementation` accepts a
        // `(session, text) => Promise<void>` signature without the
        // strict-mode "Target signature provides too few arguments"
        // error. The default implementation resolves to undefined.
        sendLiteral: vi.fn<(session: string, text: string) => Promise<void>>(
          async () => undefined
        ),
        sendKey: vi.fn<(session: string, key: string) => Promise<void>>(
          async () => undefined
        ),
        pipePane: vi.fn<(session: string, fifoPath: string) => Promise<void>>(
          async () => undefined
        ),
        stopPipePane: vi.fn<(session: string) => Promise<void>>(async () => undefined),
        resizeWindow: vi.fn<(session: string, cols: number, rows: number) => Promise<void>>(
          async () => undefined
        ),
        killSession: vi.fn<(session: string) => Promise<void>>(async () => undefined)
      }
    },
    pushMocks: {
      notifyUser: vi.fn(async () => undefined)
    },
    MockFifoStreamer
  };
});

vi.mock('../db/queries.js', () => dbMocks);
vi.mock('../tmux/TmuxSession.js', () => tmuxMocks);
vi.mock('../tmux/FifoStreamer.js', () => ({ FifoStreamer: MockFifoStreamer }));
vi.mock('../bootstrap.js', () => ({ getPushService: () => pushMocks }));

// ---------------------------------------------------------------------------
// SUT + helpers — imported AFTER vi.mock so the runtime sees the stubs.
// ---------------------------------------------------------------------------

import { AgentRuntime } from './AgentRuntime.js';

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'agent-test-1',
    user_id: 'user-1',
    role_id: 'role-1',
    repo_id: 'repo-1',
    worktree_id: 'wt-1',
    cli_kind: 'claude-code',
    tmux_session: 'maw-agent-test-1',
    status: 'spawning',
    last_attention_at: null,
    current_task_id: null,
    cli_session_id: null,
    base_sha: null,
    committer_email: null,
    head_sha_at_snapshot: null,
    commits_snapshotted_at: null,
    target_url: null,
    target_port: null,
    hook_token: null,
    model: null,
    permission_mode: null,
    source_branch: null,
    created_at: 0,
    updated_at: 0,
    ...overrides
  };
}

function makeAdapter(overrides: Partial<CliAdapter> = {}): CliAdapter {
  return {
    kind: 'shell',
    displayName: 'Shell',
    createWorktree: false,
    mobileQuickKeys: [],
    needsCliSessionId: false,
    buildSpawnSpec: () => ({ command: 'bash', args: [], env: {}, cwd: '/tmp' }),
    ingest: () => [],
    state: () => 'BOOTING',
    isIdleWaiting: () => false,
    input: {
      encode: (text: string) => (text.length === 0 ? [] : [text]),
      answerPrompt: (choice: string | number) => [String(choice), 'Enter']
    },
    ...overrides
  };
}

function ev(kind: AdapterEvent['kind'], extra: Partial<AdapterEvent> = {}): AdapterEvent {
  return {
    kind,
    at: Date.now(),
    patternId: 'test_pattern',
    detail: {},
    raw: '',
    ...extra
  };
}

/** Drive a private method onto AgentRuntime via cast — keeps tests focused on
 *  observable behavior without making `processEvent` public. */
function processEvent(rt: AgentRuntime, event: AdapterEvent, source: 'regex' | 'hook' = 'regex'): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rt as unknown as { processEvent: (e: AdapterEvent, s: 'regex' | 'hook') => void }).processEvent(
    event,
    source
  );
}

beforeEach(() => {
  Object.values(dbMocks).forEach((fn) => fn.mockClear());
  Object.values(tmuxMocks.Tmux).forEach((fn) => fn.mockClear());
  pushMocks.notifyUser.mockClear();
  // sensible defaults
  dbMocks.listRecentAlerts.mockReturnValue([]);
  dbMocks.getUserSetting.mockReturnValue(null);
  dbMocks.getLatestTerminalSeq.mockReturnValue(0);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AgentRuntime', () => {
  describe('processEvent → agents.status flips', () => {
    it("ready event → updateAgentStatus('running') and emits 'state'", () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const states: string[] = [];
      rt.on('state', (s) => states.push(s));

      processEvent(rt, ev('ready'));

      expect(dbMocks.updateAgentStatus).toHaveBeenCalledWith('agent-test-1', 'running');
      expect(states).toEqual(['running']);
    });

    it("prompt_detected → updateAgentStatus('waiting_input') + updateAgentAttention", () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const states: string[] = [];
      rt.on('state', (s) => states.push(s));

      processEvent(rt, ev('prompt_detected', { at: 1_700_000_000_000 }));

      expect(dbMocks.updateAgentStatus).toHaveBeenCalledWith('agent-test-1', 'waiting_input');
      expect(dbMocks.updateAgentAttention).toHaveBeenCalledWith('agent-test-1', 1_700_000_000);
      expect(states).toEqual(['waiting_input']);
    });

    it("task_done → updateAgentStatus('idle')", () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const states: string[] = [];
      rt.on('state', (s) => states.push(s));

      processEvent(rt, ev('task_done'));

      expect(dbMocks.updateAgentStatus).toHaveBeenCalledWith('agent-test-1', 'idle');
      expect(states).toEqual(['idle']);
    });

    it("exited → updateAgentStatus('exited')", () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const states: string[] = [];
      rt.on('state', (s) => states.push(s));

      processEvent(rt, ev('exited'));

      expect(dbMocks.updateAgentStatus).toHaveBeenCalledWith('agent-test-1', 'exited');
      expect(states).toEqual(['exited']);
    });

    it('error event does NOT change status (state machine isolation)', () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const states: string[] = [];
      rt.on('state', (s) => states.push(s));

      processEvent(rt, ev('error'));

      expect(dbMocks.updateAgentStatus).not.toHaveBeenCalled();
      expect(states).toEqual([]);
    });

    it("each event also emits an 'event' fan-out", () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const events: AdapterEvent[] = [];
      rt.on('event', (e) => events.push(e));

      processEvent(rt, ev('ready'));
      processEvent(rt, ev('prompt_detected'));

      expect(events.map((e) => e.kind)).toEqual(['ready', 'prompt_detected']);
    });

    it('insertEvent records each event with the source tag', () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      processEvent(rt, ev('ready'), 'regex');
      processEvent(rt, ev('prompt_detected'), 'hook');

      expect(dbMocks.insertEvent).toHaveBeenCalledTimes(2);
      const first = dbMocks.insertEvent.mock.calls[0]![0];
      const second = dbMocks.insertEvent.mock.calls[1]![0];
      expect(first.kind).toBe('ready');
      expect(JSON.parse(first.payload_json).source).toBe('regex');
      expect(second.kind).toBe('prompt_detected');
      expect(JSON.parse(second.payload_json).source).toBe('hook');
    });
  });

  describe('input plumbing', () => {
    it('enqueueInput("write 10 random lines", true) → sendLiteral then sendKey(Enter)', async () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      await rt.enqueueInput('write 10 random lines', true);

      expect(tmuxMocks.Tmux.sendLiteral).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.Tmux.sendLiteral).toHaveBeenCalledWith(
        'maw-agent-test-1',
        'write 10 random lines'
      );
      expect(tmuxMocks.Tmux.sendKey).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.Tmux.sendKey).toHaveBeenCalledWith('maw-agent-test-1', 'Enter');

      // Order: literal first, key second.
      const literalOrder = tmuxMocks.Tmux.sendLiteral.mock.invocationCallOrder[0]!;
      const keyOrder = tmuxMocks.Tmux.sendKey.mock.invocationCallOrder[0]!;
      expect(literalOrder).toBeLessThan(keyOrder);
    });

    it('enqueueInput(text, false) does NOT send Enter', async () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      await rt.enqueueInput('partial input', false);

      expect(tmuxMocks.Tmux.sendLiteral).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.Tmux.sendKey).not.toHaveBeenCalled();
    });

    it('enqueueRawKeys forwards cursor-key bytes verbatim through sendLiteral', async () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      // ESC[A ESC[A ESC[B = up, up, down — exact bytes that mobileQuickKeys
      // ship for arrow-key navigation in claude-code's selection prompts.
      const cursorBytes = '[A[A[B';
      await rt.enqueueRawKeys(cursorBytes);

      expect(tmuxMocks.Tmux.sendLiteral).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.Tmux.sendLiteral).toHaveBeenCalledWith('maw-agent-test-1', cursorBytes);
      expect(tmuxMocks.Tmux.sendKey).not.toHaveBeenCalled();
    });

    it('enqueueRawKeys("") is a no-op (no tmux calls)', async () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      await rt.enqueueRawKeys('');

      expect(tmuxMocks.Tmux.sendLiteral).not.toHaveBeenCalled();
      expect(tmuxMocks.Tmux.sendKey).not.toHaveBeenCalled();
    });

    it("enqueueAnswer('1') with claude-code preset → sendLiteral('1') + sendKey('Enter')", async () => {
      const agent = makeAgent({ cli_kind: 'claude-code' });
      // Adapter input mirrors claude-code.jsonc: '1' → ['1','Enter'].
      const adapter = makeAdapter({
        input: {
          encode: (t) => (t.length === 0 ? [] : [t]),
          answerPrompt: (c) => (String(c) === '1' ? ['1', 'Enter'] : [String(c), 'Enter'])
        }
      });
      const rt = new AgentRuntime(agent, adapter, '/tmp/fifos');

      await rt.enqueueAnswer('1');

      expect(tmuxMocks.Tmux.sendLiteral).toHaveBeenCalledWith('maw-agent-test-1', '1');
      expect(tmuxMocks.Tmux.sendKey).toHaveBeenCalledWith('maw-agent-test-1', 'Enter');
    });

    it("enqueueAnswer('abort') → sendKey('C-c') only, no Enter", async () => {
      const agent = makeAgent({ cli_kind: 'claude-code' });
      const adapter = makeAdapter({
        input: {
          encode: (t) => (t.length === 0 ? [] : [t]),
          // Mirrors claude-code.jsonc: "abort": ["C-c"] (no Enter — verified
          // in claude-code-lifecycle.test.ts).
          answerPrompt: (c) => (String(c) === 'abort' ? ['C-c'] : [String(c), 'Enter'])
        }
      });
      const rt = new AgentRuntime(agent, adapter, '/tmp/fifos');

      await rt.enqueueAnswer('abort');

      expect(tmuxMocks.Tmux.sendKey).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.Tmux.sendKey).toHaveBeenCalledWith('maw-agent-test-1', 'C-c');
      expect(tmuxMocks.Tmux.sendLiteral).not.toHaveBeenCalled();
    });

    it('enqueueAnswer routes Enter via sendKey and digits via sendLiteral', async () => {
      // Documents the routing rule in AgentRuntime.enqueueAnswer:
      //   key starts with /^[A-Z]/ or 'C-' → sendKey (named tmux key)
      //   else → sendLiteral (raw chars)
      const agent = makeAgent({ cli_kind: 'claude-code' });
      const adapter = makeAdapter({
        input: {
          encode: (t) => (t.length === 0 ? [] : [t]),
          answerPrompt: () => ['y', 'Enter']
        }
      });
      const rt = new AgentRuntime(agent, adapter, '/tmp/fifos');

      await rt.enqueueAnswer('yes');

      expect(tmuxMocks.Tmux.sendLiteral).toHaveBeenCalledWith('maw-agent-test-1', 'y');
      expect(tmuxMocks.Tmux.sendKey).toHaveBeenCalledWith('maw-agent-test-1', 'Enter');
    });

    it('input queue serialises: three calls dispatch in order even with async resolutions', async () => {
      // Make sendLiteral resolve at controllable rates to expose a race
      // if the queue weren't serialising. Slowest first → if they run in
      // parallel, the recorded order would NOT match dispatch.
      const order: string[] = [];
      tmuxMocks.Tmux.sendLiteral.mockImplementation(async (_session, text) => {
        const delay = text === 'a' ? 30 : text === 'b' ? 10 : 1;
        await new Promise((r) => setTimeout(r, delay));
        order.push(text);
      });

      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      const p1 = rt.enqueueInput('a', false);
      const p2 = rt.enqueueInput('b', false);
      const p3 = rt.enqueueInput('c', false);
      await Promise.all([p1, p2, p3]);

      expect(order).toEqual(['a', 'b', 'c']);
    });
  });

  describe('hook priority window suppresses regex alerts', () => {
    it('claude-code regex prompt_detected is dropped within 30s of a hook', () => {
      const agent = makeAgent({ cli_kind: 'claude-code' });
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      // Fire a Notification hook to stamp lastHookAt.
      rt.ingestHookEvent({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        tool_name: 'Bash',
        tool_input: { command: 'ls /tmp' }
      });

      // The hook itself wrote one alert.
      expect(dbMocks.insertAlert).toHaveBeenCalledTimes(1);
      dbMocks.insertAlert.mockClear();

      // A regex-source prompt with the SAME pattern arrives ~immediately.
      processEvent(
        rt,
        ev('prompt_detected', {
          patternId: 'tool_permission_prompt',
          detail: { tool: 'Bash', args: 'ls /tmp' }
        }),
        'regex'
      );

      // Expectation: no second alert (the regex was suppressed by the
      // hook-priority window). The status flip still happened — that's
      // separate from alerting.
      expect(dbMocks.insertAlert).not.toHaveBeenCalled();
      expect(dbMocks.updateAgentStatus).toHaveBeenCalledWith('agent-test-1', 'waiting_input');
    });

    it('non-claude-code agents are NOT affected by the priority window', () => {
      const agent = makeAgent({ cli_kind: 'codex' });
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      // ingestHookEvent is a no-op here (codex never POSTs hooks), but
      // even if lastHookAt were somehow stamped, the gate is gated on
      // cli_kind === 'claude-code'. Verify a regex prompt writes an alert.
      processEvent(rt, ev('prompt_detected', { patternId: 'codex_prompt' }), 'regex');

      expect(dbMocks.insertAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe('PreToolUse hook does not produce an alert', () => {
    it('stamps lastHookAt but writes no alert', () => {
      const agent = makeAgent({ cli_kind: 'claude-code' });
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      rt.ingestHookEvent({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' }
      });

      // No alert + no status flip from PreToolUse alone.
      expect(dbMocks.insertAlert).not.toHaveBeenCalled();
      expect(dbMocks.updateAgentStatus).not.toHaveBeenCalled();

      // But the priority window IS armed: a regex prompt right after
      // would be suppressed.
      processEvent(
        rt,
        ev('prompt_detected', { patternId: 'tool_permission_prompt' }),
        'regex'
      );
      expect(dbMocks.insertAlert).not.toHaveBeenCalled();
    });
  });
});
