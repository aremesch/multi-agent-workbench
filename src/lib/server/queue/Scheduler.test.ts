/**
 * QueueScheduler unit tests.
 *
 * Strategy: use the same in-memory SQLite fixture as `db/queries.test.ts`
 * for real persistence, mock `index.js` (the DB connection), and stub the
 * supervisor with a hand-rolled fake that tracks spawn calls + termination
 * listeners without touching tmux / git / the adapter registry.
 *
 * The scheduler's two halves (validation via `validateSpawnInputs` and
 * promotion via `performSpawn`) are themselves stubbed at the module level
 * because they each touch git + the supervisor's spawn path. We assert
 * scheduler bookkeeping — status transitions, slot enforcement, listener
 * reaction — rather than end-to-end agent boot.
 */
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllTables, openMemoryDb } from '../../../../tests/unit/helpers/db.js';
import type { AgentSupervisor, AgentTerminationListener } from '../agents/AgentSupervisor.js';

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

// Stub `performSpawn` so the scheduler's promotion path is observable
// without touching git / tmux / adapters. Validation falls through to the
// real implementation against the in-memory DB.
type PromoteOutcome =
  | { ok: true; agentId: string }
  | { ok: false; error: { code: 'spawnFailed'; message: string } };
let nextPromoteOutcome: PromoteOutcome = { ok: true, agentId: 'agent-stub' };
let promoteCounter = 0;
const promoteCalls: Array<{ role_id: string; repo_id: string; title: string; agentId: string }> = [];

vi.mock('../agents/spawnFromInputs.js', async () => {
  const actual = await vi.importActual<typeof import('../agents/spawnFromInputs.js')>(
    '../agents/spawnFromInputs.js'
  );
  return {
    ...actual,
    performSpawn: vi.fn(async (validated, userId, _supervisor) => {
      // Materialise a stub agent + worktree row whenever the test wants a
      // successful promotion. The supervisor's real spawn() does this; we've
      // replaced it. We rotate agentId per call so multi-promote tests get
      // distinct rows (the UNIQUE PK on agents).
      promoteCounter += 1;
      const outcomeAgentId =
        nextPromoteOutcome.ok && nextPromoteOutcome.agentId !== 'agent-stub'
          ? nextPromoteOutcome.agentId
          : `agent-stub-${promoteCounter}`;
      promoteCalls.push({
        role_id: validated.role.id,
        repo_id: validated.repo.id,
        title: validated.title,
        agentId: outcomeAgentId
      });
      if (nextPromoteOutcome.ok) {
        if (!db) throw new Error('test db not initialized');
        const wtId = `wt-for-${outcomeAgentId}`;
        db.prepare(
          `INSERT INTO worktrees (id, user_id, repo_id, path, branch, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', strftime('%s','now'), strftime('%s','now'))`
        ).run(wtId, userId, validated.repo.id, `/tmp/${wtId}`, 'main');
        db.prepare(
          `INSERT INTO agents (id, user_id, role_id, repo_id, worktree_id, cli_kind, tmux_session, status,
                               created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'running', strftime('%s','now'), strftime('%s','now'))`
        ).run(
          outcomeAgentId,
          userId,
          validated.role.id,
          validated.repo.id,
          wtId,
          validated.role.cli_kind,
          `tmux-${outcomeAgentId}`
        );
        return { ok: true, agentId: outcomeAgentId } as const;
      }
      return nextPromoteOutcome;
    }),
    validateSpawnInputs: vi.fn(async (raw, userId, _registry) => {
      // Pretend the role + repo exist; the test sets them up via the real
      // queries module so we can use the real validator's checks.
      return actual.validateSpawnInputs(raw, userId, _registry, {
        verifyBranchExists: false
      });
    })
  };
});

import {
  getQueueEntry,
  insertQueueEntry,
  insertProject,
  insertRepo,
  insertRole,
  insertUser,
  listQueueEntriesForUser,
  setQueueConcurrency
} from '../db/queries.js';
import { QueueScheduler } from './Scheduler.js';

// ----- fake supervisor -------------------------------------------------------

interface FakeRegistry {
  list(): Array<{
    kind: string;
    displayName: string;
    createWorktree: boolean;
    acceptsImageAttachment: boolean;
    agenticCodingCli: boolean;
    initialInputDelivery: 'none' | 'cli-arg';
    optionalArgs: Array<{ id: string; flag: string; label: string; default: boolean }>;
    mobileQuickKeys: Array<{ id: string; label: string; keys: string }>;
    capabilities: { model: null; permissionMode: null };
  }>;
  shouldCreateWorktree(kind: string): boolean;
  has(kind: string): boolean;
}

function makeFakeRegistry(): FakeRegistry {
  return {
    list: () => [
      {
        kind: 'shell',
        displayName: 'Shell',
        createWorktree: true,
        acceptsImageAttachment: false,
        // The scheduler itself doesn't filter on agenticCodingCli (that's the
        // queue page's job); set true here so any future test that does
        // care about the queue role-list filter sees a queueable adapter.
        agenticCodingCli: true,
        initialInputDelivery: 'none',
        optionalArgs: [],
        mobileQuickKeys: [],
        capabilities: { model: null, permissionMode: null }
      }
    ],
    shouldCreateWorktree: () => true,
    has: () => true
  };
}

function makeFakeSupervisor(): {
  supervisor: AgentSupervisor;
  fireTerminated: (agentId: string, status: 'exited' | 'crashed') => void;
  killed: string[];
} {
  const listeners = new Set<AgentTerminationListener>();
  const killed: string[] = [];
  const supervisor = {
    registry: makeFakeRegistry(),
    onAgentTerminated: (cb: AgentTerminationListener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    kill: async (agentId: string) => {
      killed.push(agentId);
    }
  } as unknown as AgentSupervisor;
  return {
    supervisor,
    fireTerminated: (agentId, status) => {
      for (const cb of listeners) cb(agentId, status);
    },
    killed
  };
}

// ----- fixtures --------------------------------------------------------------

beforeAll(() => {
  db = openMemoryDb();
});
afterAll(() => {
  db?.close();
  db = null;
});

beforeEach(() => {
  clearAllTables(db!);
  promoteCalls.length = 0;
  promoteCounter = 0;
  nextPromoteOutcome = { ok: true, agentId: 'agent-stub' };
});

function seed(): {
  userId: string;
  roleId: string;
  repoId: string;
  repoBId: string;
} {
  const userId = 'u1';
  insertUser({ id: userId, username: 'alice', password_hash: 'h', must_change_password: false });
  insertProject({ id: 'p1', user_id: userId, name: 'P', default_branch: 'main' });
  insertRepo({
    id: 'r1',
    user_id: userId,
    project_id: 'p1',
    path: '/tmp/r1',
    origin_url: null,
    default_branch: 'main'
  });
  insertRepo({
    id: 'r2',
    user_id: userId,
    project_id: 'p1',
    path: '/tmp/r2',
    origin_url: null,
    default_branch: 'main'
  });
  insertRole({
    id: 'role1',
    user_id: userId,
    name: 'Coder',
    system_prompt: '',
    cli_kind: 'shell',
    default_args_json: '[]',
    tool_config_json: '{}',
    repo_scope_json: '[]'
  });
  return { userId, roleId: 'role1', repoId: 'r1', repoBId: 'r2' };
}

interface EntryOpts {
  id?: string;
  title?: string;
  priority?: number;
  scheduledFor?: number | null;
  exclusive?: boolean;
  withWorktree?: boolean;
  dependsOn?: string[];
  repoId?: string;
}

function addEntry(
  userId: string,
  roleId: string,
  defaultRepoId: string,
  opts: EntryOpts = {}
): string {
  const id = opts.id ?? `q-${promoteCalls.length}-${Math.random().toString(36).slice(2, 8)}`;
  insertQueueEntry({
    id,
    user_id: userId,
    role_id: roleId,
    repo_id: opts.repoId ?? defaultRepoId,
    title: opts.title ?? id,
    body: null,
    target_url: null,
    model: null,
    permission_mode: null,
    source_branch: null,
    with_worktree: opts.withWorktree ?? true,
    optional_args_json: '{}',
    priority: opts.priority ?? 0,
    depends_on_json: JSON.stringify(opts.dependsOn ?? []),
    scheduled_for: opts.scheduledFor ?? null,
    exclusive: opts.exclusive ?? false,
    status: 'pending',
    external_source_json: null
  });
  return id;
}

async function tickOnce(s: QueueScheduler): Promise<void> {
  // Drive the scheduler synchronously past the debounce.
  s.scheduleTick();
  await new Promise((r) => setTimeout(r, 80));
}

// ----- tests -----------------------------------------------------------------

describe('QueueScheduler', () => {
  it('promotes a single ready entry under default 1/1 concurrency', async () => {
    const { userId, roleId, repoId } = seed();
    addEntry(userId, roleId, repoId, { id: 'q1', priority: 0 });
    const { supervisor } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    expect(promoteCalls).toHaveLength(1);
    const entry = getQueueEntry('q1');
    expect(entry?.status).toBe('running');
    scheduler.stop();
  });

  it('keeps a second entry blocked while the first is running (maxGlobal=1)', async () => {
    const { userId, roleId, repoId } = seed();
    setQueueConcurrency(userId, {
      maxConcurrentGlobal: 1,
      maxConcurrentPerRepo: 5,
      perRepoOverrides: {}
    });
    addEntry(userId, roleId, repoId, { id: 'q1', priority: 10 });
    addEntry(userId, roleId, repoId, { id: 'q2', priority: 5 });
    const { supervisor } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    expect(promoteCalls).toHaveLength(1);
    // The higher-priority entry wins.
    expect(promoteCalls[0]!.title).toBe('q1');
    expect(getQueueEntry('q1')?.status).toBe('running');
    expect(getQueueEntry('q2')?.status).toBe('ready');
    scheduler.stop();
  });

  it('respects priority ordering when multiple entries are ready', async () => {
    const { userId, roleId, repoId } = seed();
    setQueueConcurrency(userId, {
      maxConcurrentGlobal: 1,
      maxConcurrentPerRepo: 5,
      perRepoOverrides: {}
    });
    addEntry(userId, roleId, repoId, { id: 'low', priority: 1 });
    addEntry(userId, roleId, repoId, { id: 'high', priority: 10 });
    addEntry(userId, roleId, repoId, { id: 'mid', priority: 5 });
    const { supervisor } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    expect(promoteCalls).toHaveLength(1);
    expect(promoteCalls[0]!.title).toBe('high');
    scheduler.stop();
  });

  it('blocks an entry whose scheduled_for is in the future', async () => {
    const { userId, roleId, repoId } = seed();
    const future = Math.floor(Date.now() / 1000) + 3600;
    addEntry(userId, roleId, repoId, { id: 'soon', scheduledFor: future });
    const { supervisor } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    expect(promoteCalls).toHaveLength(0);
    expect(getQueueEntry('soon')?.status).toBe('blocked');
    scheduler.stop();
  });

  it('keeps a dependent entry blocked until the dependency is done', async () => {
    const { userId, roleId, repoId } = seed();
    setQueueConcurrency(userId, {
      maxConcurrentGlobal: 2,
      maxConcurrentPerRepo: 5,
      perRepoOverrides: {}
    });
    addEntry(userId, roleId, repoId, { id: 'a' });
    addEntry(userId, roleId, repoId, { id: 'b', dependsOn: ['a'] });
    const { supervisor, fireTerminated } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    // Only a should promote; b waits on its dep.
    expect(promoteCalls.map((c) => c.title)).toEqual(['a']);
    expect(getQueueEntry('b')?.status).toBe('blocked');
    // Finish a → scheduler reconciles + unblocks b.
    const aAgentId = getQueueEntry('a')!.agent_id!;
    fireTerminated(aAgentId, 'exited');
    await tickOnce(scheduler);
    expect(promoteCalls.map((c) => c.title)).toEqual(['a', 'b']);
    expect(getQueueEntry('a')?.status).toBe('done');
    scheduler.stop();
  });

  it('treats with_worktree=0 as exclusive on the repo', async () => {
    const { userId, roleId, repoId } = seed();
    setQueueConcurrency(userId, {
      maxConcurrentGlobal: 5,
      maxConcurrentPerRepo: 5,
      perRepoOverrides: {}
    });
    // First entry: worktree off → must run alone on this repo.
    addEntry(userId, roleId, repoId, {
      id: 'root',
      withWorktree: false,
      priority: 10
    });
    addEntry(userId, roleId, repoId, { id: 'other', priority: 5 });
    const { supervisor } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    expect(promoteCalls.map((c) => c.title)).toEqual(['root']);
    expect(getQueueEntry('other')?.status).toBe('ready');
    scheduler.stop();
  });

  it('marks entries done when the linked agent fires "exited"', async () => {
    const { userId, roleId, repoId } = seed();
    nextPromoteOutcome = { ok: true, agentId: 'agent-q1' };
    addEntry(userId, roleId, repoId, { id: 'q1' });
    const { supervisor, fireTerminated } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    expect(getQueueEntry('q1')?.status).toBe('running');
    fireTerminated('agent-q1', 'exited');
    await tickOnce(scheduler);
    expect(getQueueEntry('q1')?.status).toBe('done');
    scheduler.stop();
  });

  it('marks entries failed when the linked agent crashes', async () => {
    const { userId, roleId, repoId } = seed();
    nextPromoteOutcome = { ok: true, agentId: 'agent-fail' };
    addEntry(userId, roleId, repoId, { id: 'q1' });
    const { supervisor, fireTerminated } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    fireTerminated('agent-fail', 'crashed');
    await tickOnce(scheduler);
    const entry = getQueueEntry('q1');
    expect(entry?.status).toBe('failed');
    expect(entry?.last_error).toContain('crashed');
    scheduler.stop();
  });

  it('cancelEntry kills running agents and short-circuits the termination listener', async () => {
    const { userId, roleId, repoId } = seed();
    nextPromoteOutcome = { ok: true, agentId: 'agent-cancel' };
    addEntry(userId, roleId, repoId, { id: 'q1' });
    const { supervisor, killed, fireTerminated } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    expect(getQueueEntry('q1')?.status).toBe('running');
    const cancelled = await scheduler.cancelEntry('q1', userId);
    expect(cancelled).toBe(true);
    expect(killed).toEqual(['agent-cancel']);
    expect(getQueueEntry('q1')?.status).toBe('cancelled');
    // The kill propagates as a fake 'exited' from the agent termination
    // path in production; here we simulate it and assert the entry's
    // status doesn't bounce back to 'done'.
    fireTerminated('agent-cancel', 'exited');
    await tickOnce(scheduler);
    expect(getQueueEntry('q1')?.status).toBe('cancelled');
    scheduler.stop();
  });

  it('runs entries on different repos in parallel when global cap permits', async () => {
    const { userId, roleId, repoId, repoBId } = seed();
    setQueueConcurrency(userId, {
      maxConcurrentGlobal: 5,
      maxConcurrentPerRepo: 1,
      perRepoOverrides: {}
    });
    addEntry(userId, roleId, repoId, { id: 'a', repoId });
    addEntry(userId, roleId, repoBId, { id: 'b', repoId: repoBId });
    const { supervisor } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    expect(promoteCalls.map((c) => c.title).sort()).toEqual(['a', 'b']);
    scheduler.stop();
  });

  it('fails an entry whose role disappears between save and promote', async () => {
    const { userId, roleId, repoId } = seed();
    addEntry(userId, roleId, repoId, { id: 'orphan' });
    // ON DELETE RESTRICT on queue_entries.role_id means we can't drop the
    // role normally — toggle FKs for the test so we can simulate the
    // "role deleted some other way" state. The runtime never hits this
    // path because the roles DELETE endpoint refuses to delete a role
    // with active agents, but other operational paths (sqlite dump
    // surgery, migration) could.
    db!.pragma('foreign_keys = OFF');
    try {
      db!.prepare('DELETE FROM roles WHERE id = ?').run(roleId);
    } finally {
      db!.pragma('foreign_keys = ON');
    }
    const { supervisor } = makeFakeSupervisor();
    const scheduler = new QueueScheduler();
    await scheduler.start(supervisor);
    await tickOnce(scheduler);
    const entry = getQueueEntry('orphan');
    expect(entry?.status).toBe('failed');
    expect(entry?.last_error).toMatch(/unknownRole|role/);
    scheduler.stop();
  });
});
