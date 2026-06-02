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

const { dbMocks, tmuxMocks, pushMocks, MockFifoStreamer, fifoInstances } = vi.hoisted(() => {
  // Constructed instances, newest last — lets tests grab the FifoStreamer a
  // runtime built internally to drive its 'error' event and inspect calls.
  const fifoInstances: MockFifoStreamer[] = [];

  // Minimal EventEmitter-ish stub: AgentRuntime only ever subscribes to
  // 'error'. create/start/stop are spies so re-stream behavior is assertable.
  class MockFifoStreamer {
    readonly path: string;
    onChunk: ((chunk: Buffer) => void) | null = null;
    private errorHandler: ((err: unknown) => void) | null = null;
    create = vi.fn<() => Promise<void>>(async () => undefined);
    start = vi.fn<(cb: (chunk: Buffer) => void) => void>((cb) => {
      this.onChunk = cb;
    });
    stop = vi.fn<() => Promise<void>>(async () => undefined);
    constructor(opts: { fifoDir: string; agentId: string }) {
      this.path = `${opts.fifoDir}/fifo-${opts.agentId}`;
      fifoInstances.push(this);
    }
    on(event: string, handler: (err: unknown) => void): this {
      if (event === 'error') this.errorHandler = handler;
      return this;
    }
    /** Test hook: fire the 'error' event the way the real ReadStream would. */
    emitError(err: unknown): void {
      this.errorHandler?.(err);
    }
  }

  return {
    fifoInstances,
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
        hasSession: vi.fn<(session: string) => Promise<boolean>>(async () => true),
        resizeWindow: vi.fn<(session: string, cols: number, rows: number) => Promise<void>>(
          async () => undefined
        ),
        killSession: vi.fn<(session: string) => Promise<void>>(async () => undefined),
        isPaneDead: vi.fn<(session: string) => Promise<boolean>>(async () => false),
        captureDeadPaneTail: vi.fn<(session: string, lines?: number) => Promise<string>>(
          async () => ''
        )
      }
    },
    pushMocks: {
      notifyUser: vi.fn<
        (
          userId: string,
          payload: {
            title: string;
            body: string;
            data: {
              agentId: string;
              alertId: string;
              url: string;
              agentTitle?: string;
              severity?: 'info' | 'warning' | 'error' | 'critical';
            };
          }
        ) => Promise<void>
      >(async () => undefined)
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

/** Await the private FIFO-error recovery path directly so its full async
 *  chain (teardown → hasSession → re-stream) settles deterministically. */
function handleFifoError(rt: AgentRuntime, err: unknown): Promise<void> {
  return (rt as unknown as { handleFifoError: (e: unknown) => Promise<void> }).handleFifoError(err);
}

beforeEach(() => {
  Object.values(dbMocks).forEach((fn) => fn.mockClear());
  Object.values(tmuxMocks.Tmux).forEach((fn) => fn.mockClear());
  pushMocks.notifyUser.mockClear();
  fifoInstances.length = 0;
  // sensible defaults
  dbMocks.listRecentAlerts.mockReturnValue([]);
  dbMocks.getUserSetting.mockReturnValue(null);
  dbMocks.getLatestTerminalSeq.mockReturnValue(0);
  tmuxMocks.Tmux.hasSession.mockResolvedValue(true);
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

  describe('push payload structure', () => {
    it('uses task title as push title and folds reason+detail into body', () => {
      // current_task_id resolves through getTask; mock returns a titled task.
      dbMocks.getTask.mockReturnValueOnce({
        id: 'task-7',
        title: 'Implement notifications',
        body: '',
        status: 'active'
      });
      const agent = makeAgent({ cli_kind: 'claude-code', current_task_id: 'task-7' });
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      processEvent(
        rt,
        ev('prompt_detected', {
          patternId: 'tool_permission_prompt',
          detail: { tool: 'Bash', cmd: 'rm -rf /tmp/foo' }
        }),
        'regex'
      );

      expect(pushMocks.notifyUser).toHaveBeenCalledTimes(1);
      const [userId, payload] = pushMocks.notifyUser.mock.calls[0]!;
      expect(userId).toBe('user-1');
      expect(payload.title).toBe('Implement notifications');
      expect(payload.body).toBe('Permission needed: Bash — rm -rf /tmp/foo');
      expect(payload.data.agentTitle).toBe('Implement notifications');
      expect(payload.data.severity).toBe('info');
    });

    it('falls back to cli_kind as push title when no task is linked', () => {
      const agent = makeAgent({ cli_kind: 'claude-code', current_task_id: null });
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      processEvent(rt, ev('task_done'), 'regex');

      expect(pushMocks.notifyUser).toHaveBeenCalledTimes(1);
      const [, payload] = pushMocks.notifyUser.mock.calls[0]!;
      expect(payload.title).toBe('claude-code');
      // task_done has a fixed body ("Agent has finished its task.")
      expect(payload.body).toBe('Task complete — Agent has finished its task.');
    });

    it("emits the 'alert' event with agentTitle alongside reason and body", () => {
      dbMocks.getTask.mockReturnValueOnce({
        id: 'task-8',
        title: 'Refactor auth',
        body: '',
        status: 'active'
      });
      const agent = makeAgent({ cli_kind: 'claude-code', current_task_id: 'task-8' });
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      const alerts: Array<{ agentTitle: string; reason: string; body: string }> = [];
      rt.on('alert', (a) => alerts.push({ agentTitle: a.agentTitle, reason: a.reason, body: a.body }));

      processEvent(
        rt,
        ev('prompt_detected', { detail: { tool: 'Bash', cmd: 'ls' } }),
        'regex'
      );

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toEqual({
        agentTitle: 'Refactor auth',
        reason: 'Permission needed: Bash',
        body: 'ls'
      });
    });
  });

  describe('start() pane-alive verification', () => {
    it('passes through to pipePane when the pane is alive', async () => {
      tmuxMocks.Tmux.isPaneDead.mockResolvedValue(false);
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      await rt.start();

      expect(tmuxMocks.Tmux.isPaneDead).toHaveBeenCalled();
      expect(tmuxMocks.Tmux.pipePane).toHaveBeenCalledWith(
        'maw-agent-test-1',
        '/tmp/fifos/fifo-agent-test-1'
      );
      // Happy path must NOT capture or kill — those are diagnostic only.
      expect(tmuxMocks.Tmux.captureDeadPaneTail).not.toHaveBeenCalled();
      expect(tmuxMocks.Tmux.killSession).not.toHaveBeenCalled();
    });

    it('throws with captured tail when pane is dead — never reaches pipePane', async () => {
      tmuxMocks.Tmux.isPaneDead.mockResolvedValue(true);
      tmuxMocks.Tmux.captureDeadPaneTail.mockResolvedValue(
        'sh: claude: command not found'
      );
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      await expect(rt.start()).rejects.toThrow(
        /exited immediately on launch.*sh: claude: command not found/s
      );
      // Crucially: pipe-pane was never invoked — that opaque "can't find
      // pane" error stays out of the user-facing message.
      expect(tmuxMocks.Tmux.pipePane).not.toHaveBeenCalled();
      // And we kill the (dead-paned) session so it doesn't linger as
      // garbage on the tmux server.
      expect(tmuxMocks.Tmux.killSession).toHaveBeenCalledWith('maw-agent-test-1');
    });

    it('falls back to "no output captured" when the tail is empty', async () => {
      tmuxMocks.Tmux.isPaneDead.mockResolvedValue(true);
      tmuxMocks.Tmux.captureDeadPaneTail.mockResolvedValue('');
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      await expect(rt.start()).rejects.toThrow(/no output captured/);
    });

    it('catches a late death — pane alive at first probe, dead by the next', async () => {
      // Reproduces the case where exec lands microseconds AFTER tmux's
      // new-session returns: first isPaneDead poll sees pane_dead=0, a
      // few ms later the CLI exits and the next poll sees =1.
      tmuxMocks.Tmux.isPaneDead
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      tmuxMocks.Tmux.captureDeadPaneTail.mockResolvedValue('exit 1: oom');
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');

      await expect(rt.start()).rejects.toThrow(/oom/);
      expect(tmuxMocks.Tmux.pipePane).not.toHaveBeenCalled();
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

  describe('FIFO error recovery', () => {
    it("attaches an 'error' listener so a FIFO error never crashes the process", () => {
      const agent = makeAgent();
      new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const fifo = fifoInstances.at(-1)!;

      // Before the fix this re-emit had no listener → Node throws and the
      // whole process dies. The listener must absorb it synchronously.
      expect(() => fifo.emitError(new Error('EBADF: bad file descriptor, close'))).not.toThrow();
    });

    it('re-streams once (recreate FIFO + pipe-pane) when the session is still alive', async () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const fifo = fifoInstances.at(-1)!;
      tmuxMocks.Tmux.hasSession.mockResolvedValue(true);

      await handleFifoError(rt, new Error('EBADF'));

      // Broken reader + stale pipe-pane torn down first…
      expect(tmuxMocks.Tmux.stopPipePane).toHaveBeenCalledWith('maw-agent-test-1');
      expect(fifo.stop).toHaveBeenCalled();
      // …then the stream is rebuilt and re-attached.
      expect(tmuxMocks.Tmux.hasSession).toHaveBeenCalledWith('maw-agent-test-1');
      expect(fifo.create).toHaveBeenCalledTimes(1);
      expect(fifo.start).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.Tmux.pipePane).toHaveBeenCalledWith('maw-agent-test-1', fifo.path);
    });

    it('does NOT re-stream when the tmux session is gone (leaves stream stopped)', async () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const fifo = fifoInstances.at(-1)!;
      tmuxMocks.Tmux.hasSession.mockResolvedValue(false);

      await handleFifoError(rt, new Error('EBADF'));

      // Teardown still happens, but no rebuild.
      expect(fifo.stop).toHaveBeenCalled();
      expect(fifo.create).not.toHaveBeenCalled();
      expect(tmuxMocks.Tmux.pipePane).not.toHaveBeenCalled();
    });

    it('suppresses a second re-stream within the cooldown window (no tight loop)', async () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const fifo = fifoInstances.at(-1)!;
      tmuxMocks.Tmux.hasSession.mockResolvedValue(true);

      await handleFifoError(rt, new Error('EBADF #1'));
      await handleFifoError(rt, new Error('EBADF #2'));

      // First incident rebuilds; the immediate second one is left stopped.
      expect(fifo.create).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.Tmux.pipePane).toHaveBeenCalledTimes(1);
    });

    it('no-ops once the runtime has been stopped', async () => {
      const agent = makeAgent();
      const rt = new AgentRuntime(agent, makeAdapter(), '/tmp/fifos');
      const fifo = fifoInstances.at(-1)!;
      await rt.stop();
      fifo.create.mockClear();
      fifo.stop.mockClear();
      tmuxMocks.Tmux.pipePane.mockClear();

      await handleFifoError(rt, new Error('EBADF after stop'));

      expect(fifo.create).not.toHaveBeenCalled();
      expect(fifo.stop).not.toHaveBeenCalled();
      expect(tmuxMocks.Tmux.pipePane).not.toHaveBeenCalled();
    });
  });
});
