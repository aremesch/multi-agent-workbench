/**
 * SupervisorEngine state-machine tests.
 *
 * Strategy mirrors Scheduler.test.ts: real persistence on an in-memory SQLite
 * fixture (mock db/index.js), with the engine's impure collaborators (LLM, git,
 * agent input, scheduler, notify) injected as fakes. We simulate agent
 * promotion + completion by writing the queue/agent rows the real scheduler
 * would write, then invoking the handlers the engine subscribed.
 */
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllTables, openMemoryDb } from '../../../../tests/unit/helpers/db.js';
import type { AdapterEvent } from '../../shared/adapterTypes.js';

let db: Database.Database | null = null;

vi.mock('../db/index.js', () => ({
  getDb: () => {
    if (!db) throw new Error('test db not initialized');
    return db;
  },
  withTx: <T>(fn: (d: Database.Database) => T): T => {
    if (!db) throw new Error('test db not initialized');
    return db.transaction(fn)(db);
  },
  closeDb: () => {}
}));

import {
  getSupervisorRun,
  getSupervisorStep,
  insertAgent,
  insertRepo,
  insertRole,
  insertSupervisorRun,
  insertUser,
  insertWorktree,
  listProjectMemory,
  listSupervisorSteps,
  updateQueueEntryStatus,
  updateSupervisorStep,
  DEFAULT_SUPERVISOR_SETTINGS
} from '../db/queries.js';
import {
  SupervisorEngine,
  type SupervisorEngineDeps,
  type SupervisorNotice
} from './SupervisorEngine.js';

const RUN_ID = 'run1';

function seed(configOverrides: Record<string, unknown> = {}): void {
  insertUser({ id: 'u1', username: 'u', password_hash: 'h' });
  insertRepo({ id: 'r1', user_id: 'u1', path: '/tmp/r1', origin_url: null, default_branch: 'main' });
  insertRole({
    id: 'role-code',
    user_id: 'u1',
    name: 'Coder',
    system_prompt: 'code',
    cli_kind: 'claude-code',
    default_args_json: '[]',
    tool_config_json: '{}',
    repo_scope_json: '[]'
  });
  insertRole({
    id: 'role-qc',
    user_id: 'u1',
    name: 'QC',
    system_prompt: 'review carefully',
    cli_kind: 'claude-code',
    default_args_json: '[]',
    tool_config_json: '{}',
    repo_scope_json: '[]'
  });
  insertSupervisorRun({
    id: RUN_ID,
    user_id: 'u1',
    repo_id: 'r1',
    role_id: 'role-code',
    qc_role_id: 'role-qc',
    title: 'Build it',
    plan_md: 'A big plan',
    phase: 'planning',
    config_json: JSON.stringify({ ...DEFAULT_SUPERVISOR_SETTINGS, stallTimeoutSec: 0, fixLoopCap: 2, ...configOverrides })
  });
}

interface Harness {
  engine: SupervisorEngine;
  deps: SupervisorEngineDeps;
  notices: SupervisorNotice[];
  qcVerdictFn: ReturnType<typeof vi.fn>;
  verifyCommitFn: ReturnType<typeof vi.fn>;
  pushBranchFn: ReturnType<typeof vi.fn>;
  inputCalls: string[];
  liveAgents: Set<string>;
  onQueueChange: (entryId: string) => void;
  onAgentEvent: (agentId: string, ev: AdapterEvent) => void;
}

async function makeEngine(): Promise<Harness> {
  const notices: SupervisorNotice[] = [];
  const inputCalls: string[] = [];
  const liveAgents = new Set<string>();
  const qcVerdictFn = vi.fn(async () => ({
    result: { verdict: 'pass' as const, summary: 'ok', issues: [] },
    usage: { tokensIn: 1, tokensOut: 1 }
  }));
  const verifyCommitFn = vi.fn(async () => ({ committed: true, head: 'newsha', dirty: false }));
  const pushBranchFn = vi.fn(async () => {});

  const deps: SupervisorEngineDeps = {
    scheduleTick: () => {},
    cancelEntry: vi.fn(async (entryId: string) => {
      updateQueueEntryStatus(entryId, { status: 'cancelled' });
      return true;
    }),
    getAgentInput: (agentId: string) =>
      liveAgents.has(agentId)
        ? {
            enqueueInput: async (text: string) => {
              inputCalls.push(`${agentId}:${text.slice(0, 20)}`);
            }
          }
        : undefined,
    splitPlanFn: vi.fn(async () => ({
      result: {
        tasks: [
          { title: 'Step one', body: 'do one' },
          { title: 'Step two', body: 'do two', depends_on: [0] }
        ]
      },
      usage: { tokensIn: 1, tokensOut: 1 }
    })) as unknown as SupervisorEngineDeps['splitPlanFn'],
    qcVerdictFn: qcVerdictFn as unknown as SupervisorEngineDeps['qcVerdictFn'],
    verifyCommitFn,
    pushBranchFn,
    diffSinceFn: async () => 'diff --git a b',
    notify: (n) => notices.push(n),
    apiKey: 'k'
  };

  const engine = new SupervisorEngine();
  let onQueueChange!: (entryId: string) => void;
  let onAgentEvent!: (agentId: string, ev: AdapterEvent) => void;
  await engine.start(deps, (h) => {
    onQueueChange = h.onQueueChange;
    onAgentEvent = h.onAgentEvent;
    return [];
  });
  return { engine, deps, notices, qcVerdictFn, verifyCommitFn, pushBranchFn, inputCalls, liveAgents, onQueueChange, onAgentEvent };
}

/** Simulate the scheduler promoting a step's (coding or QC) queue entry. */
function promote(h: Harness, entryId: string, agentId: string, branch: string): void {
  insertWorktree({ id: `wt-${agentId}`, user_id: 'u1', repo_id: 'r1', path: `/tmp/wt/${agentId}`, branch, status: 'active' });
  insertAgent({
    id: agentId,
    user_id: 'u1',
    role_id: 'role-code',
    repo_id: 'r1',
    worktree_id: `wt-${agentId}`,
    cli_kind: 'claude-code',
    tmux_session: `sess-${agentId}`,
    status: 'running',
    cli_session_id: null,
    base_sha: 'basesha'
  });
  updateQueueEntryStatus(entryId, { status: 'running', agent_id: agentId });
  h.liveAgents.add(agentId);
  h.onQueueChange(entryId);
}

function taskDone(): AdapterEvent {
  return { kind: 'task_done', at: Date.now() };
}

beforeAll(() => {
  db = openMemoryDb();
});
afterAll(() => {
  db?.close();
  db = null;
});
beforeEach(() => {
  if (db) clearAllTables(db);
});

describe('planning + approval', () => {
  it('splits the plan into steps and awaits approval', async () => {
    seed();
    const h = await makeEngine();
    await h.engine.startPlanning(RUN_ID);
    const run = getSupervisorRun(RUN_ID)!;
    expect(run.phase).toBe('awaiting_approval');
    const steps = listSupervisorSteps(RUN_ID);
    expect(steps).toHaveLength(2);
    // index-based depends_on was rewritten to step ids
    expect(JSON.parse(steps[1]!.depends_on_json)).toEqual([steps[0]!.id]);
    h.engine.stop();
  });

  it('marks the run failed when planning throws', async () => {
    seed();
    const h = await makeEngine();
    (h.deps.splitPlanFn as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await h.engine.startPlanning(RUN_ID);
    expect(getSupervisorRun(RUN_ID)!.phase).toBe('failed');
    expect(h.notices.some((n) => n.severity === 'error')).toBe(true);
    h.engine.stop();
  });
});

describe('happy path execution', () => {
  it('drives a step: task → commit → QC pass → push → done, then next step', async () => {
    seed();
    const h = await makeEngine();
    await h.engine.startPlanning(RUN_ID);
    const steps = listSupervisorSteps(RUN_ID);
    for (const s of steps) updateSupervisorStep(s.id, { approval_state: 'approved' });

    h.engine.approveRun(RUN_ID);
    await Promise.resolve();
    // step one is now running_task with a queue entry
    let s1 = getSupervisorStep(steps[0]!.id)!;
    expect(s1.phase).toBe('running_task');
    expect(s1.queue_entry_id).toBeTruthy();

    promote(h, s1.queue_entry_id!, 'agent-1', 'step-one');
    s1 = getSupervisorStep(steps[0]!.id)!;
    expect(s1.agent_id).toBe('agent-1');
    expect(s1.branch).toBe('step-one');
    expect(s1.base_sha).toBe('basesha');

    // agent finishes its turn → commit verified → QC enqueued
    h.onAgentEvent('agent-1', taskDone());
    await new Promise((r) => setTimeout(r, 0));
    s1 = getSupervisorStep(steps[0]!.id)!;
    expect(s1.phase).toBe('quality_check');
    expect(s1.qc_queue_entry_id).toBeTruthy();

    // QC agent promoted + finishes → verdict pass → push → done
    promote(h, s1.qc_queue_entry_id!, 'qc-1', 'qc-step-one');
    h.onAgentEvent('qc-1', taskDone());
    await new Promise((r) => setTimeout(r, 0));

    s1 = getSupervisorStep(steps[0]!.id)!;
    expect(s1.phase).toBe('done');
    expect(h.pushBranchFn).toHaveBeenCalledWith('/tmp/wt/agent-1', 'step-one');
    expect(h.notices.some((n) => n.reason.startsWith('Step ready for PR'))).toBe(true);

    // step two should now have started (depends_on step one, now done)
    const s2 = getSupervisorStep(steps[1]!.id)!;
    expect(s2.phase).toBe('running_task');
    h.engine.stop();
  });
});

describe('QC fail → fix loop', () => {
  it('sends fixes to the live agent and caps the loop', async () => {
    seed({ fixLoopCap: 1 });
    const h = await makeEngine();
    h.qcVerdictFn.mockResolvedValue({
      result: {
        verdict: 'fail',
        summary: 'nope',
        issues: [{ category: 'dry', severity: 'high', detail: 'dup code' }]
      },
      usage: { tokensIn: 1, tokensOut: 1 }
    });
    await h.engine.startPlanning(RUN_ID);
    const steps = listSupervisorSteps(RUN_ID);
    updateSupervisorStep(steps[0]!.id, { approval_state: 'approved' });
    h.engine.approveRun(RUN_ID);
    await Promise.resolve();

    let s1 = getSupervisorStep(steps[0]!.id)!;
    promote(h, s1.queue_entry_id!, 'agent-1', 'step-one');
    h.onAgentEvent('agent-1', taskDone());
    await new Promise((r) => setTimeout(r, 0));
    s1 = getSupervisorStep(steps[0]!.id)!;
    promote(h, s1.qc_queue_entry_id!, 'qc-1', 'qc-1');
    h.onAgentEvent('qc-1', taskDone());
    await new Promise((r) => setTimeout(r, 0));

    // QC failed → fix sent to the live coding agent
    s1 = getSupervisorStep(steps[0]!.id)!;
    expect(s1.phase).toBe('fixing');
    expect(s1.fix_iterations).toBe(1);
    expect(h.inputCalls.some((c) => c.startsWith('agent-1:'))).toBe(true);
    // project memory recorded the recurring issue
    expect(listProjectMemory('r1').some((m) => m.category === 'dry')).toBe(true);

    // agent commits the fix → QC again → still fail → cap reached → blocked
    h.onAgentEvent('agent-1', taskDone());
    await new Promise((r) => setTimeout(r, 0));
    s1 = getSupervisorStep(steps[0]!.id)!;
    promote(h, s1.qc_queue_entry_id!, 'qc-2', 'qc-2');
    h.onAgentEvent('qc-2', taskDone());
    await new Promise((r) => setTimeout(r, 0));

    s1 = getSupervisorStep(steps[0]!.id)!;
    expect(s1.phase).toBe('blocked_on_human');
    expect(h.notices.some((n) => n.reason.startsWith('Supervisor needs you'))).toBe(true);
    h.engine.stop();
  });
});

describe('stop semantics', () => {
  it('emergency stop cancels entries and marks the run stopped', async () => {
    seed();
    const h = await makeEngine();
    await h.engine.startPlanning(RUN_ID);
    const steps = listSupervisorSteps(RUN_ID);
    updateSupervisorStep(steps[0]!.id, { approval_state: 'approved' });
    h.engine.approveRun(RUN_ID);
    await Promise.resolve();
    const s1 = getSupervisorStep(steps[0]!.id)!;
    promote(h, s1.queue_entry_id!, 'agent-1', 'step-one');

    await h.engine.requestStop(RUN_ID, 'emergency');
    expect(getSupervisorRun(RUN_ID)!.phase).toBe('stopped');
    expect(h.deps.cancelEntry).toHaveBeenCalled();
    expect(getSupervisorStep(steps[0]!.id)!.phase).toBe('failed');
    h.engine.stop();
  });

  it('normal stop lets nothing new start and finishes when idle', async () => {
    seed();
    const h = await makeEngine();
    await h.engine.startPlanning(RUN_ID);
    const steps = listSupervisorSteps(RUN_ID);
    for (const s of steps) updateSupervisorStep(s.id, { approval_state: 'approved' });
    h.engine.approveRun(RUN_ID);
    await Promise.resolve();

    // step one in flight; request normal stop → run goes 'stopping'
    await h.engine.requestStop(RUN_ID, 'normal');
    expect(getSupervisorRun(RUN_ID)!.phase).toBe('stopping');

    // finish step one fully
    let s1 = getSupervisorStep(steps[0]!.id)!;
    promote(h, s1.queue_entry_id!, 'agent-1', 'step-one');
    h.onAgentEvent('agent-1', taskDone());
    await new Promise((r) => setTimeout(r, 0));
    s1 = getSupervisorStep(steps[0]!.id)!;
    promote(h, s1.qc_queue_entry_id!, 'qc-1', 'qc-1');
    h.onAgentEvent('qc-1', taskDone());
    await new Promise((r) => setTimeout(r, 0));

    // normal stop → step two never starts, run is stopped
    expect(getSupervisorStep(steps[1]!.id)!.phase).toBe('pending');
    expect(getSupervisorRun(RUN_ID)!.phase).toBe('stopped');
    h.engine.stop();
  });
});
