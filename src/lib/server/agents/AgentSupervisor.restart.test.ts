/**
 * AgentSupervisor.restart unit tests.
 *
 * Strategy mirrors Scheduler.test.ts: real persistence via an in-memory
 * SQLite fixture (mock `../db/index.js`), with every side-effecting
 * collaborator (tmux, AgentRuntime, git worktree validation, claude config
 * dir, push, playwright, alert bus) stubbed. We assert the supervisor's
 * bookkeeping — in-place revival, run insertion, resume-vs-fresh decision,
 * validation rejection, and launch-failure recovery — not real agent boot.
 */

import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllTables, openMemoryDb } from '../../../../tests/unit/helpers/db.js';
import type { AdapterRegistry } from './adapters/AdapterRegistry.js';

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

vi.mock('../config.js', () => ({
  getConfig: () => ({
    port: 4000,
    host: '127.0.0.1',
    fifoDir: '/tmp/fifo',
    worktreeRoot: '/wt',
    dataDir: '/tmp/data',
    anthropicApiKey: 'sk-test',
    claudeCodeOauthToken: '',
    giteaToken: 'gitea-pat-xyz'
  })
}));

const newSessionMock = vi.fn((_arg?: unknown): Promise<void> => Promise.resolve());
const killSessionMock = vi.fn((_arg?: unknown): Promise<void> => Promise.resolve());
vi.mock('../tmux/TmuxSession.js', () => ({
  Tmux: {
    newSession: (arg: unknown) => newSessionMock(arg),
    killSession: (arg: unknown) => killSessionMock(arg),
    sessionName: (id: string) => `maw-${id}`,
    listMawSessions: async () => [],
    hasSession: async () => false,
    ensureGlobalSessionClosedHook: async () => {},
    ensureSpawnDiagnosticsHooks: async () => {},
    exitChannel: (s: string) => `maw-exit-${s}`,
    // A never-resolving promise with a kill() — so the exit watcher never
    // fires finishAsExited during the test, and stopExitWatcher can abort it.
    spawnWaitForChannel: () => Object.assign(new Promise<void>(() => {}), { kill: vi.fn() })
  }
}));

const startMock = vi.fn((): Promise<void> => Promise.resolve());
vi.mock('./AgentRuntime.js', () => ({
  AgentRuntime: class {
    agent: { tmux_session: string };
    constructor(agent: { tmux_session: string }) {
      this.agent = agent;
    }
    start = () => startMock();
    stop = async () => {};
    on = () => {};
    emit = () => {};
    get tmuxSession(): string {
      return this.agent.tmux_session;
    }
  },
  agentDisplayName: (a: { id: string }) => a.id
}));

const validateForReuseMock = vi.fn((_arg?: unknown): Promise<unknown> => Promise.resolve({}));
vi.mock('../git/WorktreeManager.js', () => ({
  WorktreeManager: {
    validateForReuse: (arg: unknown) => validateForReuseMock(arg)
  }
}));

vi.mock('./claudeConfigDir.js', () => ({
  agentClaudeConfigDir: (id: string) => `/tmp/data/agents/${id}/claude`,
  ensureAgentClaudeConfigDir: (id: string) => `/tmp/data/agents/${id}/claude`,
  removeAgentClaudeConfigDir: () => {}
}));

vi.mock('./claudeHooks.js', () => ({
  generateHookToken: () => 'hook-tok',
  writeClaudeHookSettings: () => {}
}));

vi.mock('../git/commitSnapshot.js', () => ({
  snapshotAgentCommits: async () => ({ captured: 0, source: 'test' })
}));

vi.mock('../bootstrap.js', () => ({
  getPushService: () => ({ notifyUser: async () => {} })
}));

vi.mock('../user/gitIdentity.js', () => ({
  resolveGitIdentityForUser: () => ({ name: 'User', email: 'user@example.com' })
}));

vi.mock('../preview/PlaywrightSessionManager.js', () => ({
  getPlaywrightSessions: () => ({ start: async () => {}, stop: async () => {} })
}));

vi.mock('./AlertBus.js', () => ({
  getAlertBus: () => ({ emitUserAlert: () => {} })
}));

const existsSyncMock = vi.fn((_p?: string): boolean => false);
vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...real, existsSync: (p: string) => existsSyncMock(p) };
});

import { AgentSupervisor } from './AgentSupervisor.js';
import {
  getAgent,
  insertAgent,
  insertAgentRun,
  insertRepo,
  insertRole,
  insertTask,
  insertUser,
  insertWorktree,
  updateAgentCurrentTask,
  updateAgentStatus
} from '../db/queries.js';

const fakeAdapter = {
  kind: 'claude-code',
  displayName: 'Claude Code',
  createWorktree: true,
  mobileQuickKeys: [],
  needsCliSessionId: true,
  supportsResume: true,
  buildSpawnSpec: vi.fn(() => ({ command: 'claude', args: ['--x'], env: {}, cwd: '/wt/x' })),
  ingest: () => [],
  state: () => 'BOOTING' as const,
  isIdleWaiting: () => false,
  input: { encode: () => [], answerPrompt: () => [] }
};

const registry = {
  has: (k: string) => k === 'claude-code',
  create: () => fakeAdapter
} as unknown as AdapterRegistry;

function seedCrashedAgent(opts: { cliSessionId?: string | null } = {}): void {
  insertUser({ id: 'u1', username: 'u', password_hash: 'h' });
  insertRepo({ id: 'r1', user_id: 'u1', path: '/repo', origin_url: null, default_branch: 'main' });
  insertRole({
    id: 'role1',
    user_id: 'u1',
    name: 'R',
    system_prompt: 'sys',
    cli_kind: 'claude-code',
    default_args_json: '{}',
    tool_config_json: '{}',
    repo_scope_json: '{}'
  });
  insertWorktree({
    id: 'wt1',
    user_id: 'u1',
    repo_id: 'r1',
    path: '/wt/x',
    branch: 'feat/x',
    status: 'active'
  });
  insertAgent({
    id: 'a1',
    user_id: 'u1',
    role_id: 'role1',
    repo_id: 'r1',
    worktree_id: 'wt1',
    cli_kind: 'claude-code',
    tmux_session: 'maw-a1',
    status: 'crashed',
    cli_session_id: opts.cliSessionId === undefined ? 'sess-1' : opts.cliSessionId,
    source_branch: 'feat/x',
    model: 'opus',
    permission_mode: 'plan',
    hook_token: 'hook-tok'
  });
  insertTask({
    id: 't1',
    user_id: 'u1',
    agent_id: 'a1',
    title: 'T',
    body: 'do the work',
    status: 'active',
    assigned_by_agent_id: null
  });
  updateAgentCurrentTask('a1', 't1');
  // The original (crashed) run.
  insertAgentRun({ id: 'run0', user_id: 'u1', agent_id: 'a1', started_at: 100 });
}

function runCount(agentId: string): number {
  const row = db!
    .prepare('SELECT COUNT(*) AS c FROM agent_runs WHERE agent_id = ?')
    .get(agentId) as { c: number };
  return row.c;
}

function agentCount(): number {
  const row = db!.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number };
  return row.c;
}

let sup: AgentSupervisor;

beforeAll(() => {
  // One DB for the whole file: queries.ts caches prepared statements against
  // the first connection getDb() hands out, so a per-test reconnect would
  // leave the cache bound to a closed handle. Wipe rows between tests instead.
  db = openMemoryDb();
});

afterAll(() => {
  db?.close();
  db = null;
});

beforeEach(() => {
  clearAllTables(db!);
  newSessionMock.mockReset();
  killSessionMock.mockReset();
  startMock.mockReset();
  startMock.mockResolvedValue(undefined);
  validateForReuseMock.mockReset();
  validateForReuseMock.mockResolvedValue({ ok: true, recreated: false, path: '/wt/x' });
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
  fakeAdapter.buildSpawnSpec.mockClear();
  sup = new AgentSupervisor(registry);
});

describe('AgentSupervisor.restart', () => {
  it('revives a crashed agent in place: same row, new run, status running', async () => {
    seedCrashedAgent();
    const res = await sup.restart('a1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.id).toBe('a1');
    expect(getAgent('a1')!.status).toBe('running');
    expect(agentCount()).toBe(1); // no new agent row
    expect(runCount('a1')).toBe(2); // original run + the revived run
    expect(newSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'maw-a1' })
    );
  });

  it('forwards GITEA_TOKEN from config into the agent spawn env', async () => {
    seedCrashedAgent();
    const res = await sup.restart('a1');
    expect(res.ok).toBe(true);
    // The launchCliRuntime choke point injects the configured Gitea token so
    // every agent kind can open PRs via the API. spawn() shares this tail.
    expect(newSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ GITEA_TOKEN: 'gitea-pat-xyz' })
      })
    );
  });

  it("resumes (mode='resume') when a transcript survives", async () => {
    seedCrashedAgent();
    existsSyncMock.mockReturnValue(true); // transcript present
    const res = await sup.restart('a1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe('resume');
    expect(fakeAdapter.buildSpawnSpec).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'resume' })
    );
  });

  it("falls back to fresh (mode='spawn' argv) when no transcript exists", async () => {
    seedCrashedAgent();
    existsSyncMock.mockReturnValue(false);
    const res = await sup.restart('a1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe('fresh');
    expect(fakeAdapter.buildSpawnSpec).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'spawn' })
    );
  });

  it('rejects with worktree_gone and leaves the row crashed', async () => {
    seedCrashedAgent();
    validateForReuseMock.mockResolvedValue({ ok: false, code: 'worktree_gone' });
    const res = await sup.restart('a1');
    expect(res).toEqual({ ok: false, code: 'worktree_gone' });
    expect(getAgent('a1')!.status).toBe('crashed');
    expect(runCount('a1')).toBe(1); // no new run
  });

  it('rejects a non-crashed (exited) agent with not_crashed', async () => {
    seedCrashedAgent();
    updateAgentStatus('a1', 'exited');
    const res = await sup.restart('a1');
    expect(res).toEqual({ ok: false, code: 'not_crashed' });
    expect(newSessionMock).not.toHaveBeenCalled();
  });

  it('on launch failure flips back to crashed WITHOUT deleting the row', async () => {
    seedCrashedAgent();
    startMock.mockRejectedValueOnce(new Error('cli died on launch'));
    const res = await sup.restart('a1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('launch_failed');
    // Contrast with spawn(): the row is preserved so the user can retry.
    expect(getAgent('a1')).toBeDefined();
    expect(getAgent('a1')!.status).toBe('crashed');
  });
});
