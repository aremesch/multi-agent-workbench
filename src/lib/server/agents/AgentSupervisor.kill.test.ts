/**
 * AgentSupervisor.kill unit tests.
 *
 * Focus: a kill must ALWAYS archive the agent to `exited`, even when the tmux
 * teardown fails. The motivating bug: a start-project agent wedged at
 * `spawning` (launch never completed → no runtime, session already gone) could
 * not be stopped, because `Tmux.killSession` rethrew the tmux "no current
 * target" error and `supervisor.kill()` ran the status flip only AFTER the
 * (unguarded) kill. See docs/plans/fix-fail-dossier-start-project.md.
 *
 * Mock strategy mirrors AgentSupervisor.restart.test.ts: real persistence via
 * an in-memory SQLite fixture, every side-effecting collaborator stubbed.
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
    claudeCodeOauthToken: ''
  })
}));

const killSessionMock = vi.fn((_arg?: unknown): Promise<void> => Promise.resolve());
vi.mock('../tmux/TmuxSession.js', () => ({
  Tmux: {
    killSession: (arg: unknown) => killSessionMock(arg),
    sessionName: (id: string) => `maw-${id}`,
    spawnWaitForChannel: () => Object.assign(new Promise<void>(() => {}), { kill: vi.fn() })
  }
}));

vi.mock('./AgentRuntime.js', () => ({
  AgentRuntime: class {},
  agentDisplayName: (a: { id: string }) => a.id
}));

const removeConfigDirMock = vi.fn();
vi.mock('./claudeConfigDir.js', () => ({
  agentClaudeConfigDir: (id: string) => `/tmp/data/agents/${id}/claude`,
  ensureAgentClaudeConfigDir: (id: string) => `/tmp/data/agents/${id}/claude`,
  removeAgentClaudeConfigDir: (id: string) => removeConfigDirMock(id)
}));

const snapshotMock = vi.fn(async () => ({ captured: 0, source: 'test' }));
vi.mock('../git/commitSnapshot.js', () => ({
  snapshotAgentCommits: () => snapshotMock()
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

import { AgentSupervisor } from './AgentSupervisor.js';
import {
  getAgent,
  insertAgent,
  insertRepo,
  insertRole,
  insertUser,
  insertWorktree
} from '../db/queries.js';

const registry = {
  has: (k: string) => k === 'claude-code',
  create: () => ({})
} as unknown as AdapterRegistry;

/**
 * Seed an agent wedged at `spawning`: launch never completed, so there is no
 * runtime in the supervisor's map and no `agent_runs` row — exactly the live
 * dossier case.
 */
function seedSpawningAgent(): void {
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
  // Mode-B (with_worktree=0): the worktree row points at the repo root.
  insertWorktree({
    id: 'wt1',
    user_id: 'u1',
    repo_id: 'r1',
    path: '/repo',
    branch: 'main',
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
    status: 'spawning',
    cli_session_id: 'sess-1',
    source_branch: 'main',
    model: 'opus',
    permission_mode: 'plan',
    hook_token: 'hook-tok'
  });
}

function sessionGoneError(): Error & { stderr: string } {
  return Object.assign(new Error('Command failed with exit code 1'), { stderr: 'no current target' });
}

let sup: AgentSupervisor;

beforeAll(() => {
  db = openMemoryDb();
});

afterAll(() => {
  db?.close();
  db = null;
});

beforeEach(() => {
  clearAllTables(db!);
  killSessionMock.mockReset();
  killSessionMock.mockResolvedValue(undefined);
  removeConfigDirMock.mockReset();
  snapshotMock.mockReset();
  snapshotMock.mockResolvedValue({ captured: 0, source: 'test' });
  sup = new AgentSupervisor(registry);
});

describe('AgentSupervisor.kill', () => {
  it('archives a wedged spawning agent even when killSession throws "no current target"', async () => {
    seedSpawningAgent();
    killSessionMock.mockRejectedValueOnce(sessionGoneError());
    const terminated: Array<[string, string]> = [];
    sup.onAgentTerminated((id, status) => terminated.push([id, status]));

    await expect(sup.kill('a1')).resolves.toBeUndefined();

    expect(getAgent('a1')!.status).toBe('exited');
    expect(terminated).toContainEqual(['a1', 'exited']);
    // claude-code config dir is still cleaned up (independent of tmux).
    expect(removeConfigDirMock).toHaveBeenCalledWith('a1');
  });

  it('still archives when killSession throws a non-session-gone error', async () => {
    seedSpawningAgent();
    killSessionMock.mockRejectedValueOnce(new Error('permission denied'));

    await expect(sup.kill('a1')).resolves.toBeUndefined();

    // Resilience: the DB flip is unconditional so the user can always clear a
    // wedge, regardless of why tmux teardown failed.
    expect(getAgent('a1')!.status).toBe('exited');
  });

  it('happy path: killSession resolves, agent archived to exited', async () => {
    seedSpawningAgent();

    await sup.kill('a1');

    expect(killSessionMock).toHaveBeenCalledWith('maw-a1');
    expect(getAgent('a1')!.status).toBe('exited');
  });

  it('no-ops on an unknown agent id', async () => {
    await expect(sup.kill('nope')).resolves.toBeUndefined();
    expect(killSessionMock).not.toHaveBeenCalled();
  });
});
