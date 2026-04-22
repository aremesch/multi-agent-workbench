import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllTables, openMemoryDb } from '../../../../tests/unit/helpers/db.js';

// Shared in-memory DB for the whole file. The mock factory returns
// closures that read `db` at call time, so assigning in beforeAll (after
// the factory has been registered) is fine.
let db: Database.Database | null = null;

vi.mock('./index.js', () => ({
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
  acknowledgeAlert,
  closeAgentRun,
  countUsers,
  deleteAgent,
  updateRepo,
  deletePushSubByEndpoint,
  deleteSession,
  deleteSessionsForUserExcept,
  deleteExpiredSessions,
  findWorktreeByPath,
  getAgent,
  getLatestRunForAgent,
  getLatestTerminalSeq,
  getProject,
  getRepo,
  getRole,
  getSessionById,
  getSpawnDefaults,
  getSpawnDefaultsAll,
  getUserById,
  getUserByUsername,
  getUserSetting,
  getWorktree,
  insertAgent,
  insertAgentRun,
  insertAlert,
  insertAuthEvent,
  insertEvent,
  insertMessage,
  insertProject,
  insertRepo,
  insertRole,
  insertSession,
  insertTask,
  insertTerminalChunk,
  insertUser,
  insertWorktree,
  listAgentCardsForRepo,
  listAgentCardsForUser,
  listAgentRuns,
  listAgentsForUser,
  listAllTerminalChunks,
  listEventsForAgent,
  listInbox,
  listLiveAgents,
  listProjects,
  listPushSubsForUser,
  listRecentAlerts,
  listRecentAuthEvents,
  listReposForProject,
  listReposForUser,
  listReposWithProjectForUser,
  listRoles,
  listTasksForAgent,
  listTerminalChunksSince,
  listWorktreesForRepo,
  markMessageRead,
  pruneTerminalLogByBytes,
  setMustChangePassword,
  setUserSetting,
  summarizeTerminalActivity,
  updateAgentAttention,
  updateAgentCommitSnapshot,
  updateAgentCurrentTask,
  updateAgentStatus,
  updateUserPasswordHash,
  updateWorktreeStatus,
  upsertPushSub
} from './queries.js';

beforeAll(() => {
  db = openMemoryDb();
});

afterAll(() => {
  db?.close();
  db = null;
});

beforeEach(() => {
  clearAllTables(db!);
});

// ----- fixtures -----------------------------------------------------------

function seedUser(id = 'user-1', username = 'alice'): void {
  insertUser({
    id,
    username,
    password_hash: 'hash-' + id,
    must_change_password: false
  });
}

function seedProject(id = 'proj-1', userId = 'user-1', name = 'Proj'): void {
  insertProject({ id, user_id: userId, name, default_branch: 'main' });
}

function seedRepo(
  id = 'repo-1',
  userId = 'user-1',
  projectId: string | null = 'proj-1',
  path = '/tmp/repo'
): void {
  insertRepo({
    id,
    user_id: userId,
    project_id: projectId,
    path,
    origin_url: null,
    default_branch: 'main'
  });
}

function seedWorktree(
  id = 'wt-1',
  userId = 'user-1',
  repoId = 'repo-1',
  path = '/tmp/wt',
  branch = 'maw/agent-1'
): void {
  insertWorktree({ id, user_id: userId, repo_id: repoId, path, branch, status: 'active' });
}

function seedRole(id = 'role-1', userId = 'user-1'): void {
  insertRole({
    id,
    user_id: userId,
    name: 'Coder',
    system_prompt: 'you are a coder',
    cli_kind: 'claude-code',
    default_args_json: '[]',
    tool_config_json: '{}',
    repo_scope_json: '[]'
  });
}

function seedAgent(
  id = 'agent-1',
  userId = 'user-1',
  overrides: Partial<Parameters<typeof insertAgent>[0]> = {}
): void {
  insertAgent({
    id,
    user_id: userId,
    role_id: 'role-1',
    repo_id: 'repo-1',
    worktree_id: 'wt-1',
    cli_kind: 'claude-code',
    tmux_session: `maw-${id}`,
    status: 'running',
    cli_session_id: 'sess-uuid',
    ...overrides
  });
}

function seedFullStack(): void {
  seedUser();
  seedProject();
  seedRepo();
  seedWorktree();
  seedRole();
  seedAgent();
}

// ----- users --------------------------------------------------------------

describe('users', () => {
  it('insertUser + getUserByUsername round-trip', () => {
    seedUser('u1', 'alice');
    const row = getUserByUsername('alice');
    expect(row?.id).toBe('u1');
    expect(row?.password_hash).toBe('hash-u1');
    expect(row?.must_change_password).toBe(0);
  });

  it('getUserById resolves by id', () => {
    seedUser('u1', 'bob');
    expect(getUserById('u1')?.username).toBe('bob');
    expect(getUserById('missing')).toBeUndefined();
  });

  it('countUsers reflects inserts', () => {
    expect(countUsers()).toBe(0);
    seedUser('u1');
    seedUser('u2', 'two');
    expect(countUsers()).toBe(2);
  });

  it('updateUserPasswordHash updates the hash and timestamps', () => {
    seedUser('u1');
    updateUserPasswordHash('u1', 'new-hash');
    const u = getUserById('u1');
    expect(u?.password_hash).toBe('new-hash');
    expect(u?.password_updated_at).toBeGreaterThan(0);
  });

  it('setMustChangePassword flips the flag in both directions', () => {
    seedUser('u1');
    setMustChangePassword('u1', true);
    expect(getUserById('u1')?.must_change_password).toBe(1);
    setMustChangePassword('u1', false);
    expect(getUserById('u1')?.must_change_password).toBe(0);
  });
});

// ----- auth events --------------------------------------------------------

describe('auth events', () => {
  it('insertAuthEvent + listRecentAuthEvents returns newest-first', () => {
    insertAuthEvent({ ts: 1000, event: 'login_ok', username: 'alice' });
    insertAuthEvent({ ts: 2000, event: 'login_fail', username: 'alice', ip: '1.2.3.4' });
    const rows = listRecentAuthEvents(10);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ts).toBe(2000);
    expect(rows[0]?.event).toBe('login_fail');
    expect(rows[0]?.ip).toBe('1.2.3.4');
  });

  it('listRecentAuthEvents respects limit', () => {
    for (let i = 0; i < 5; i++) {
      insertAuthEvent({ ts: i, event: 'ping' });
    }
    expect(listRecentAuthEvents(3)).toHaveLength(3);
  });

  it('accepts nullable fields', () => {
    insertAuthEvent({ ts: 1, event: 'x' });
    const rows = listRecentAuthEvents(1);
    expect(rows[0]?.user_id).toBeNull();
    expect(rows[0]?.ip).toBeNull();
  });
});

// ----- sessions -----------------------------------------------------------

describe('sessions', () => {
  const FUTURE = Math.floor(Date.now() / 1000) + 3600;
  const PAST = Math.floor(Date.now() / 1000) - 3600;

  beforeEach(() => {
    seedUser('u1');
  });

  it('insertSession + getSessionById round-trip', () => {
    insertSession({
      id: 'sess-1',
      user_id: 'u1',
      expires_at: FUTURE,
      user_agent: 'Mozilla/5.0'
    });
    const row = getSessionById('sess-1');
    expect(row?.user_id).toBe('u1');
    expect(row?.expires_at).toBe(FUTURE);
    expect(row?.user_agent).toBe('Mozilla/5.0');
  });

  it('deleteSession removes the row', () => {
    insertSession({ id: 'sess-1', user_id: 'u1', expires_at: FUTURE, user_agent: null });
    deleteSession('sess-1');
    expect(getSessionById('sess-1')).toBeUndefined();
  });

  it('deleteExpiredSessions removes only past-expiry rows', () => {
    insertSession({ id: 'fresh', user_id: 'u1', expires_at: FUTURE, user_agent: null });
    insertSession({ id: 'stale', user_id: 'u1', expires_at: PAST, user_agent: null });
    expect(deleteExpiredSessions()).toBe(1);
    expect(getSessionById('fresh')).toBeDefined();
    expect(getSessionById('stale')).toBeUndefined();
  });

  it('deleteSessionsForUserExcept preserves the caller session', () => {
    insertSession({ id: 'a', user_id: 'u1', expires_at: FUTURE, user_agent: null });
    insertSession({ id: 'b', user_id: 'u1', expires_at: FUTURE, user_agent: null });
    insertSession({ id: 'c', user_id: 'u1', expires_at: FUTURE, user_agent: null });
    deleteSessionsForUserExcept('u1', 'b');
    expect(getSessionById('a')).toBeUndefined();
    expect(getSessionById('b')).toBeDefined();
    expect(getSessionById('c')).toBeUndefined();
  });
});

// ----- projects -----------------------------------------------------------

describe('projects', () => {
  beforeEach(() => {
    seedUser();
  });

  it('insertProject + getProject + listProjects', () => {
    seedProject('p1', 'user-1', 'Bravo');
    seedProject('p2', 'user-1', 'Alpha');
    expect(getProject('p1')?.name).toBe('Bravo');
    const list = listProjects('user-1');
    // Ordered by name: Alpha < Bravo.
    expect(list.map((p) => p.name)).toEqual(['Alpha', 'Bravo']);
  });

  it('listProjects is scoped to user_id', () => {
    seedUser('u2', 'bob');
    seedProject('p1', 'user-1');
    seedProject('p2', 'u2');
    expect(listProjects('user-1').map((p) => p.id)).toEqual(['p1']);
    expect(listProjects('u2').map((p) => p.id)).toEqual(['p2']);
  });
});

// ----- repos --------------------------------------------------------------

describe('repos', () => {
  beforeEach(() => {
    seedUser();
    seedProject();
  });

  it('insertRepo + getRepo + listReposForUser', () => {
    seedRepo('r1');
    seedRepo('r2', 'user-1', null, '/tmp/solo');
    expect(getRepo('r1')?.path).toBe('/tmp/repo');
    expect(getRepo('r2')?.project_id).toBeNull();
    const list = listReposForUser('user-1');
    expect(list.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it('listReposForProject is scoped to project_id', () => {
    seedRepo('r1', 'user-1', 'proj-1');
    seedRepo('r2', 'user-1', null, '/tmp/solo');
    expect(listReposForProject('proj-1').map((r) => r.id)).toEqual(['r1']);
  });

  it('listReposWithProjectForUser joins project name, NULL for unprojected repos', () => {
    seedRepo('r1', 'user-1', 'proj-1');
    seedRepo('r2', 'user-1', null, '/tmp/solo');
    const rows = listReposWithProjectForUser('user-1');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['r1']?.project_name).toBe('Proj');
    expect(byId['r2']?.project_name).toBeNull();
  });

  it('updateRepo sets origin_url for the owner and bumps updated_at', async () => {
    seedRepo('r1');
    const before = getRepo('r1')!;
    await new Promise((r) => setTimeout(r, 1100));
    const ok = updateRepo({ id: 'r1', user_id: 'user-1', origin_url: 'https://example.com/x.git' });
    expect(ok).toBe(true);
    const after = getRepo('r1')!;
    expect(after.origin_url).toBe('https://example.com/x.git');
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
  });

  it('updateRepo clears origin_url when passed null', () => {
    insertRepo({
      id: 'r1',
      user_id: 'user-1',
      project_id: 'proj-1',
      path: '/tmp/repo',
      origin_url: 'https://example.com/x.git',
      default_branch: 'main'
    });
    expect(updateRepo({ id: 'r1', user_id: 'user-1', origin_url: null })).toBe(true);
    expect(getRepo('r1')?.origin_url).toBeNull();
  });

  it('updateRepo returns false for a foreign user and leaves the row unchanged', () => {
    insertRepo({
      id: 'r1',
      user_id: 'user-1',
      project_id: 'proj-1',
      path: '/tmp/repo',
      origin_url: 'https://original.example/x.git',
      default_branch: 'main'
    });
    const ok = updateRepo({ id: 'r1', user_id: 'attacker', origin_url: 'https://evil.example' });
    expect(ok).toBe(false);
    expect(getRepo('r1')?.origin_url).toBe('https://original.example/x.git');
  });

  it('updateRepo returns false when the repo does not exist', () => {
    expect(
      updateRepo({ id: 'nope', user_id: 'user-1', origin_url: 'https://example.com' })
    ).toBe(false);
  });
});

// ----- worktrees ----------------------------------------------------------

describe('worktrees', () => {
  beforeEach(() => {
    seedUser();
    seedProject();
    seedRepo();
  });

  it('insertWorktree + getWorktree + findWorktreeByPath', () => {
    seedWorktree('wt-1', 'user-1', 'repo-1', '/tmp/wt-1');
    expect(getWorktree('wt-1')?.branch).toBe('maw/agent-1');
    expect(findWorktreeByPath('/tmp/wt-1')?.id).toBe('wt-1');
    expect(findWorktreeByPath('/no/such')).toBeUndefined();
  });

  it('listWorktreesForRepo is scoped to repo_id', () => {
    seedWorktree('wt-1', 'user-1', 'repo-1', '/tmp/wt-1');
    seedWorktree('wt-2', 'user-1', 'repo-1', '/tmp/wt-2');
    expect(listWorktreesForRepo('repo-1')).toHaveLength(2);
    expect(listWorktreesForRepo('other')).toHaveLength(0);
  });

  it('updateWorktreeStatus writes new status and bumps updated_at', () => {
    seedWorktree('wt-1');
    const before = getWorktree('wt-1')!.updated_at;
    // Tight: ensure the bump is observable regardless of clock resolution.
    updateWorktreeStatus('wt-1', 'orphaned');
    const row = getWorktree('wt-1')!;
    expect(row.status).toBe('orphaned');
    expect(row.updated_at).toBeGreaterThanOrEqual(before);
  });
});

// ----- roles --------------------------------------------------------------

describe('roles', () => {
  beforeEach(() => {
    seedUser();
  });

  it('insertRole + getRole + listRoles', () => {
    seedRole('role-1');
    expect(getRole('role-1')?.name).toBe('Coder');
    expect(listRoles('user-1').map((r) => r.id)).toEqual(['role-1']);
  });
});

// ----- agents -------------------------------------------------------------

describe('agents', () => {
  beforeEach(() => {
    seedUser();
    seedProject();
    seedRepo();
    seedWorktree();
    seedRole();
  });

  it('insertAgent + getAgent persists cli_session_id', () => {
    seedAgent('a1', 'user-1', { cli_session_id: 'uuid-abc' });
    const row = getAgent('a1');
    expect(row?.cli_session_id).toBe('uuid-abc');
    expect(row?.status).toBe('running');
  });

  it('insertAgent accepts null cli_session_id', () => {
    seedAgent('a1', 'user-1', { cli_session_id: null });
    expect(getAgent('a1')?.cli_session_id).toBeNull();
  });

  it('listLiveAgents filters on the live statuses only', () => {
    seedAgent('live-1', 'user-1', { status: 'running' });
    seedAgent('live-2', 'user-1', { status: 'waiting_input' });
    seedAgent('live-3', 'user-1', { status: 'idle' });
    seedAgent('live-4', 'user-1', { status: 'spawning' });
    seedAgent('dead-1', 'user-1', { status: 'exited' });
    seedAgent('dead-2', 'user-1', { status: 'crashed' });
    const ids = listLiveAgents()
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual(['live-1', 'live-2', 'live-3', 'live-4']);
  });

  it('updateAgentStatus walks through the full state machine', () => {
    seedAgent('a1', 'user-1', { status: 'spawning' });
    for (const s of ['running', 'waiting_input', 'idle', 'exited'] as const) {
      updateAgentStatus('a1', s);
      expect(getAgent('a1')?.status).toBe(s);
    }
  });

  it('updateAgentAttention and updateAgentCurrentTask thread through', () => {
    seedAgent('a1', 'user-1');
    updateAgentAttention('a1', 12345);
    expect(getAgent('a1')?.last_attention_at).toBe(12345);
    insertTask({
      id: 't1',
      user_id: 'user-1',
      agent_id: 'a1',
      title: 'do thing',
      body: 'body',
      status: 'active',
      assigned_by_agent_id: null
    });
    updateAgentCurrentTask('a1', 't1');
    expect(getAgent('a1')?.current_task_id).toBe('t1');
    updateAgentCurrentTask('a1', null);
    expect(getAgent('a1')?.current_task_id).toBeNull();
  });

  it('updateAgentCommitSnapshot writes snapshot fields without bumping updated_at', () => {
    // Archive falls back to agent.updated_at for the "ended" timestamp
    // when no run row carries an ended_at. A manual commits refresh must
    // not shift that display — so the snapshot-metadata update must
    // leave updated_at alone.
    seedAgent('a1', 'user-1');
    const before = getAgent('a1')!;
    const beforeUpdatedAt = before.updated_at;
    // Force a clock gap so any bump would be observable.
    db!.prepare('UPDATE agents SET updated_at = ? WHERE id = ?').run(
      beforeUpdatedAt - 10_000,
      'a1'
    );
    const pinned = getAgent('a1')!.updated_at;
    updateAgentCommitSnapshot('a1', 'deadbee', 1_700_000_000);
    const after = getAgent('a1')!;
    expect(after.head_sha_at_snapshot).toBe('deadbee');
    expect(after.commits_snapshotted_at).toBe(1_700_000_000);
    expect(after.updated_at).toBe(pinned);
  });

  it('deleteAgent removes the row', () => {
    seedAgent('a1');
    deleteAgent('a1');
    expect(getAgent('a1')).toBeUndefined();
  });

  it('listAgentsForUser is newest-first and scoped to user', () => {
    seedUser('u2', 'bob');
    seedAgent('a1', 'user-1');
    seedAgent('a2', 'user-1');
    seedAgent('other', 'u2');
    const mine = listAgentsForUser('user-1').map((a) => a.id);
    expect(mine).toContain('a1');
    expect(mine).toContain('a2');
    expect(mine).not.toContain('other');
  });
});

// ----- agent card join queries -------------------------------------------

describe('agent card join queries', () => {
  beforeEach(() => {
    seedFullStack();
  });

  it('listAgentCardsForUser joins role / repo / project / task', () => {
    insertTask({
      id: 't1',
      user_id: 'user-1',
      agent_id: 'agent-1',
      title: 'implement x',
      body: '',
      status: 'active',
      assigned_by_agent_id: null
    });
    updateAgentCurrentTask('agent-1', 't1');

    const cards = listAgentCardsForUser('user-1', ['running']);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.role_name).toBe('Coder');
    expect(cards[0]?.repo_path).toBe('/tmp/repo');
    expect(cards[0]?.project_name).toBe('Proj');
    expect(cards[0]?.task_title).toBe('implement x');
  });

  it('returns [] for empty status list', () => {
    expect(listAgentCardsForUser('user-1', [])).toEqual([]);
    expect(listAgentCardsForRepo('user-1', 'repo-1', [])).toEqual([]);
  });

  it('listAgentCardsForRepo scopes by repo_id', () => {
    seedRepo('repo-other', 'user-1', 'proj-1', '/tmp/other');
    seedWorktree('wt-other', 'user-1', 'repo-other', '/tmp/wt-other');
    insertAgent({
      id: 'agent-other',
      user_id: 'user-1',
      role_id: 'role-1',
      repo_id: 'repo-other',
      worktree_id: 'wt-other',
      cli_kind: 'claude-code',
      tmux_session: 'maw-other',
      status: 'running',
      cli_session_id: null
    });
    const thisRepo = listAgentCardsForRepo('user-1', 'repo-1', ['running']);
    expect(thisRepo.map((c) => c.id)).toEqual(['agent-1']);
  });
});

// ----- agent runs ---------------------------------------------------------

describe('agent runs', () => {
  beforeEach(() => {
    seedFullStack();
  });

  it('insertAgentRun + listAgentRuns newest-first', () => {
    insertAgentRun({ id: 'run-1', user_id: 'user-1', agent_id: 'agent-1', started_at: 100 });
    insertAgentRun({ id: 'run-2', user_id: 'user-1', agent_id: 'agent-1', started_at: 200 });
    const runs = listAgentRuns('agent-1').map((r) => r.id);
    expect(runs).toEqual(['run-2', 'run-1']);
  });

  it('closeAgentRun writes ended_at / exit_code / reason', () => {
    insertAgentRun({ id: 'run-1', user_id: 'user-1', agent_id: 'agent-1', started_at: 100 });
    closeAgentRun('run-1', 999, 0, 'clean exit');
    const row = getLatestRunForAgent('agent-1');
    expect(row?.ended_at).toBe(999);
    expect(row?.exit_code).toBe(0);
    expect(row?.reason).toBe('clean exit');
  });

  it('getLatestRunForAgent returns undefined when no runs exist', () => {
    expect(getLatestRunForAgent('agent-1')).toBeUndefined();
  });
});

// ----- tasks --------------------------------------------------------------

describe('tasks', () => {
  beforeEach(() => {
    seedFullStack();
  });

  it('insertTask + listTasksForAgent returns both rows scoped by agent', () => {
    // insertTask derives created_at from Date.now() at second resolution,
    // so sub-second ordering isn't observable from the test. We assert
    // presence and scoping rather than tie-breaking.
    insertTask({
      id: 't1',
      user_id: 'user-1',
      agent_id: 'agent-1',
      title: 'first',
      body: '',
      status: 'done',
      assigned_by_agent_id: null
    });
    insertTask({
      id: 't2',
      user_id: 'user-1',
      agent_id: 'agent-1',
      title: 'second',
      body: '',
      status: 'active',
      assigned_by_agent_id: null
    });
    const titles = listTasksForAgent('agent-1')
      .map((t) => t.title)
      .sort();
    expect(titles).toEqual(['first', 'second']);
  });

  it('listTasksForAgent does not leak rows from other agents', () => {
    insertAgent({
      id: 'agent-other',
      user_id: 'user-1',
      role_id: 'role-1',
      repo_id: 'repo-1',
      worktree_id: 'wt-1',
      cli_kind: 'claude-code',
      tmux_session: 'other',
      status: 'running',
      cli_session_id: null
    });
    insertTask({
      id: 't-mine',
      user_id: 'user-1',
      agent_id: 'agent-1',
      title: 'mine',
      body: '',
      status: 'active',
      assigned_by_agent_id: null
    });
    insertTask({
      id: 't-other',
      user_id: 'user-1',
      agent_id: 'agent-other',
      title: 'theirs',
      body: '',
      status: 'active',
      assigned_by_agent_id: null
    });
    expect(listTasksForAgent('agent-1').map((t) => t.id)).toEqual(['t-mine']);
  });
});

// ----- terminal log -------------------------------------------------------

describe('terminal log', () => {
  beforeEach(() => {
    seedFullStack();
  });

  function chunk(id: string, seq: number, ts: number, bytes = 'x'): void {
    insertTerminalChunk({
      id,
      user_id: 'user-1',
      agent_id: 'agent-1',
      seq,
      ts,
      chunk: Buffer.from(bytes)
    });
  }

  it('insertTerminalChunk + getLatestTerminalSeq', () => {
    expect(getLatestTerminalSeq('agent-1')).toBe(0);
    chunk('c1', 1, 100);
    chunk('c2', 2, 200);
    expect(getLatestTerminalSeq('agent-1')).toBe(2);
  });

  it('listTerminalChunksSince returns strictly-greater seqs in order', () => {
    chunk('c1', 1, 100);
    chunk('c2', 2, 200);
    chunk('c3', 3, 300);
    const since = listTerminalChunksSince('agent-1', 1).map((c) => c.seq);
    expect(since).toEqual([2, 3]);
  });

  it('listAllTerminalChunks returns every chunk in seq order', () => {
    chunk('c2', 2, 200);
    chunk('c1', 1, 100);
    expect(listAllTerminalChunks('agent-1').map((c) => c.seq)).toEqual([1, 2]);
  });

  it('summarizeTerminalActivity classifies gaps as active or idle', () => {
    chunk('c1', 1, 0, 'a');
    chunk('c2', 2, 10, 'a'); // 10s gap → active (< 30s threshold)
    chunk('c3', 3, 100, 'a'); // 90s gap → idle
    chunk('c4', 4, 110, 'a'); // 10s → active
    const summary = summarizeTerminalActivity('agent-1', 30);
    expect(summary.chunkCount).toBe(4);
    expect(summary.firstTs).toBe(0);
    expect(summary.lastTs).toBe(110);
    expect(summary.activeSec).toBe(20);
    expect(summary.idleSec).toBe(90);
  });

  it('summarizeTerminalActivity empty-case returns zeros', () => {
    expect(summarizeTerminalActivity('agent-1')).toEqual({
      activeSec: 0,
      idleSec: 0,
      firstTs: null,
      lastTs: null,
      chunkCount: 0
    });
  });

  it('pruneTerminalLogByBytes deletes oldest chunks until under budget', () => {
    // Three chunks, 100 bytes each = 300 total. Budget 150 → drop oldest.
    chunk('c1', 1, 100, 'a'.repeat(100));
    chunk('c2', 2, 200, 'a'.repeat(100));
    chunk('c3', 3, 300, 'a'.repeat(100));
    const deleted = pruneTerminalLogByBytes('agent-1', 150);
    expect(deleted).toBe(2);
    const kept = listAllTerminalChunks('agent-1').map((c) => c.seq);
    expect(kept).toEqual([3]);
  });

  it('pruneTerminalLogByBytes is a no-op when already under budget', () => {
    chunk('c1', 1, 100, 'a');
    expect(pruneTerminalLogByBytes('agent-1', 1024)).toBe(0);
    expect(listAllTerminalChunks('agent-1')).toHaveLength(1);
  });
});

// ----- events -------------------------------------------------------------

describe('events', () => {
  beforeEach(() => {
    seedFullStack();
  });

  it('insertEvent + listEventsForAgent (newest-first, limit)', () => {
    for (let i = 1; i <= 5; i++) {
      insertEvent({
        id: `e${i}`,
        user_id: 'user-1',
        agent_id: 'agent-1',
        kind: 'state',
        payload_json: `{"n":${i}}`,
        ts: i
      });
    }
    const rows = listEventsForAgent('agent-1', 3).map((e) => e.id);
    expect(rows).toEqual(['e5', 'e4', 'e3']);
  });
});

// ----- messages -----------------------------------------------------------

describe('messages', () => {
  beforeEach(() => {
    seedFullStack();
  });

  it('insertMessage + listInbox orders by ts ascending', () => {
    insertMessage({
      id: 'm1',
      user_id: 'user-1',
      from_agent_id: null,
      to_agent_id: 'agent-1',
      kind: 'note',
      body: 'hi',
      ts: 200
    });
    insertMessage({
      id: 'm2',
      user_id: 'user-1',
      from_agent_id: null,
      to_agent_id: 'agent-1',
      kind: 'note',
      body: 'earlier',
      ts: 100
    });
    const rows = listInbox('agent-1').map((m) => m.id);
    expect(rows).toEqual(['m2', 'm1']);
  });

  it('listInbox(onlyUnread) filters by read_at NULL', () => {
    insertMessage({
      id: 'm1',
      user_id: 'user-1',
      from_agent_id: null,
      to_agent_id: 'agent-1',
      kind: 'note',
      body: '',
      ts: 100
    });
    insertMessage({
      id: 'm2',
      user_id: 'user-1',
      from_agent_id: null,
      to_agent_id: 'agent-1',
      kind: 'note',
      body: '',
      ts: 200
    });
    markMessageRead('m1');
    const unread = listInbox('agent-1', true).map((m) => m.id);
    expect(unread).toEqual(['m2']);
  });
});

// ----- alerts -------------------------------------------------------------

describe('alerts', () => {
  beforeEach(() => {
    seedFullStack();
  });

  it('insertAlert + listRecentAlerts filters by ts ≥ sinceTs', () => {
    insertAlert({
      id: 'a1',
      user_id: 'user-1',
      agent_id: 'agent-1',
      severity: 'error',
      reason: 'boom',
      payload_json: '{}',
      ts: 50
    });
    insertAlert({
      id: 'a2',
      user_id: 'user-1',
      agent_id: 'agent-1',
      severity: 'warning',
      reason: 'meh',
      payload_json: '{}',
      ts: 200
    });
    const recent = listRecentAlerts('agent-1', 100).map((a) => a.id);
    expect(recent).toEqual(['a2']);
  });

  it('acknowledgeAlert sets acknowledged_at', () => {
    insertAlert({
      id: 'a1',
      user_id: 'user-1',
      agent_id: 'agent-1',
      severity: 'info',
      reason: 'x',
      payload_json: '{}',
      ts: 1
    });
    acknowledgeAlert('a1');
    const rows = listRecentAlerts('agent-1', 0);
    expect(rows[0]?.acknowledged_at).toBeGreaterThan(0);
  });
});

// ----- push subscriptions -------------------------------------------------

describe('push subscriptions', () => {
  beforeEach(() => {
    seedUser();
  });

  it('upsertPushSub inserts and then updates on conflicting endpoint', () => {
    upsertPushSub({
      id: 'p1',
      user_id: 'user-1',
      endpoint: 'https://push/1',
      p256dh: 'old-p256',
      auth: 'old-auth',
      ua: null
    });
    upsertPushSub({
      id: 'p1-ignored',
      user_id: 'user-1',
      endpoint: 'https://push/1',
      p256dh: 'new-p256',
      auth: 'new-auth',
      ua: 'Mozilla'
    });
    const subs = listPushSubsForUser('user-1');
    expect(subs).toHaveLength(1);
    expect(subs[0]?.p256dh).toBe('new-p256');
    expect(subs[0]?.auth).toBe('new-auth');
    expect(subs[0]?.ua).toBe('Mozilla');
  });

  it('deletePushSubByEndpoint targets a single endpoint', () => {
    upsertPushSub({
      id: 'p1',
      user_id: 'user-1',
      endpoint: 'https://push/1',
      p256dh: '',
      auth: '',
      ua: null
    });
    upsertPushSub({
      id: 'p2',
      user_id: 'user-1',
      endpoint: 'https://push/2',
      p256dh: '',
      auth: '',
      ua: null
    });
    deletePushSubByEndpoint('https://push/1');
    expect(listPushSubsForUser('user-1').map((s) => s.endpoint)).toEqual([
      'https://push/2'
    ]);
  });

  it('listPushSubsForUser is scoped per user', () => {
    seedUser('u2', 'bob');
    upsertPushSub({
      id: 'p1',
      user_id: 'user-1',
      endpoint: 'https://push/a',
      p256dh: '',
      auth: '',
      ua: null
    });
    upsertPushSub({
      id: 'p2',
      user_id: 'u2',
      endpoint: 'https://push/b',
      p256dh: '',
      auth: '',
      ua: null
    });
    expect(listPushSubsForUser('user-1').map((s) => s.id)).toEqual(['p1']);
    expect(listPushSubsForUser('u2').map((s) => s.id)).toEqual(['p2']);
  });
});

// ----- user settings ------------------------------------------------------

describe('user settings', () => {
  beforeEach(() => {
    seedUser();
  });

  it('setUserSetting + getUserSetting round-trip', () => {
    setUserSetting('user-1', 'foo', '"bar"');
    expect(getUserSetting('user-1', 'foo')).toBe('"bar"');
    expect(getUserSetting('user-1', 'missing')).toBeNull();
  });

  it('setUserSetting upserts on existing (user_id, key)', () => {
    setUserSetting('user-1', 'foo', '1');
    setUserSetting('user-1', 'foo', '2');
    expect(getUserSetting('user-1', 'foo')).toBe('2');
  });

  it('getSpawnDefaults parses JSON and returns null on missing / malformed', () => {
    expect(getSpawnDefaults('user-1', 'claude-code')).toBeNull();

    setUserSetting(
      'user-1',
      'spawn.defaults.claude-code',
      JSON.stringify({ optionalArgs: { '--verbose': true } })
    );
    const defaults = getSpawnDefaults('user-1', 'claude-code');
    expect(defaults?.optionalArgs['--verbose']).toBe(true);

    setUserSetting('user-1', 'spawn.defaults.broken', '{not-json');
    expect(getSpawnDefaults('user-1', 'broken')).toBeNull();
  });

  it('getSpawnDefaultsAll returns a map keyed by cli kind, omitting missing', () => {
    setUserSetting(
      'user-1',
      'spawn.defaults.claude-code',
      JSON.stringify({ optionalArgs: { '--x': true } })
    );
    const all = getSpawnDefaultsAll('user-1', ['claude-code', 'codex']);
    expect(Object.keys(all)).toEqual(['claude-code']);
  });
});
