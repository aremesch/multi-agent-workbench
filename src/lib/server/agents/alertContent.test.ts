/**
 * Pure-function tests for the alert renderers exported from
 * AgentRuntime.ts (`alertReason` and `alertBody`). Both are exercised
 * standalone here without spinning up a real runtime — the heavy
 * orchestration (FifoStreamer + tmux) lives behind the class boundary
 * and isn't relevant to formatting.
 */

import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEvent } from '$shared/adapterTypes';
import type { AgentRow } from '../db/types.js';
import {
  clearAllTables,
  openMemoryDb
} from '../../../../tests/unit/helpers/db.js';

let db: Database.Database | null = null;

vi.mock('../db/index.js', () => ({
  getDb: () => {
    if (!db) throw new Error('test db not initialized');
    return db;
  },
  closeDb: () => {}
}));

import { alertReason, alertBody, agentDisplayName } from './AgentRuntime.js';
import {
  insertAgent,
  insertProject,
  insertRepo,
  insertRole,
  insertTask,
  insertUser,
  insertWorktree
} from '../db/queries.js';

beforeAll(() => {
  db = openMemoryDb();
});
afterAll(() => {
  db?.close();
  db = null;
});
beforeEach(() => {
  if (db) clearAllTables(db);
  // Seed the FK chain — task FKs reference user, agent, etc. The
  // alertContent functions don't require any of this; it's only here
  // because `getTask(...)` is read at runtime by `agentDisplayName`.
  insertUser({ id: 'u1', username: 'alice', password_hash: 'hash' });
  insertProject({ id: 'p1', user_id: 'u1', name: 'P', default_branch: 'main' });
  insertRepo({
    id: 'repo-1',
    user_id: 'u1',
    project_id: 'p1',
    path: '/tmp/r',
    origin_url: null,
    default_branch: 'main'
  });
  insertWorktree({
    id: 'wt-1',
    user_id: 'u1',
    repo_id: 'repo-1',
    path: '/tmp/wt',
    branch: 'maw/agent-1',
    status: 'active'
  });
  insertRole({
    id: 'role-1',
    user_id: 'u1',
    name: 'Coder',
    system_prompt: 'sp',
    cli_kind: 'claude-code',
    default_args_json: '[]',
    tool_config_json: '{}',
    repo_scope_json: '[]'
  });
  insertAgent({
    id: 'agent-1',
    user_id: 'u1',
    role_id: 'role-1',
    repo_id: 'repo-1',
    worktree_id: 'wt-1',
    cli_kind: 'claude-code',
    tmux_session: 'maw-agent-1',
    status: 'running',
    cli_session_id: null
  });
});

const baseAgent = (over: Partial<AgentRow> = {}): AgentRow => ({
  id: 'agent-1',
  user_id: 'u1',
  role_id: 'role-1',
  repo_id: 'repo-1',
  worktree_id: 'wt-1',
  cli_kind: 'claude-code',
  tmux_session: 'maw-agent-1',
  status: 'running',
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
  created_at: 0,
  updated_at: 0,
  ...over
});

const ev = (over: Partial<AdapterEvent> = {}): AdapterEvent => ({
  kind: 'prompt_detected',
  at: Date.now(),
  patternId: 'unspecified',
  detail: {},
  raw: '',
  ...over
});

describe('agentDisplayName', () => {
  it('returns the task title when current_task_id resolves', () => {
    insertTask({
      id: 'task-1',
      user_id: 'u1',
      agent_id: 'agent-1',
      title: 'Implement notifications',
      body: 'do the thing',
      status: 'active',
      assigned_by_agent_id: null
    });
    const a = baseAgent({ current_task_id: 'task-1' });
    expect(agentDisplayName(a)).toBe('Implement notifications');
  });

  it('falls back to cli_kind when no current_task_id', () => {
    expect(agentDisplayName(baseAgent({ cli_kind: 'codex' }))).toBe('codex');
  });

  it('falls back to cli_kind when current_task_id points at a missing row', () => {
    const a = baseAgent({ current_task_id: 'missing' });
    expect(agentDisplayName(a)).toBe('claude-code');
  });

  it('falls back to cli_kind when the task title is empty/whitespace', () => {
    insertTask({
      id: 'task-empty',
      user_id: 'u1',
      agent_id: 'agent-1',
      title: '   ',
      body: '',
      status: 'active',
      assigned_by_agent_id: null
    });
    const a = baseAgent({ current_task_id: 'task-empty' });
    expect(agentDisplayName(a)).toBe('claude-code');
  });
});

describe('alertReason', () => {
  it('uses cli_kind when no task is set', () => {
    expect(alertReason(baseAgent(), ev({ kind: 'prompt_detected' }))).toBe(
      'claude-code · Permission needed'
    );
  });

  it('appends detail.tool to permission prompts', () => {
    const out = alertReason(
      baseAgent(),
      ev({ kind: 'prompt_detected', detail: { tool: 'Bash' } })
    );
    expect(out).toBe('claude-code · Permission needed: Bash');
  });

  it('appends detail.action when no tool is present', () => {
    const out = alertReason(
      baseAgent({ cli_kind: 'codex' }),
      ev({ kind: 'prompt_detected', detail: { action: 'apply diff' } })
    );
    expect(out).toBe('codex · Permission needed: apply diff');
  });

  it('formats task_done', () => {
    const out = alertReason(baseAgent(), ev({ kind: 'task_done' }));
    expect(out).toBe('claude-code · Task complete');
  });

  it('formats error with patternId', () => {
    const out = alertReason(
      baseAgent(),
      ev({ kind: 'error', patternId: 'rate_limit' })
    );
    expect(out).toBe('claude-code · rate_limit');
  });

  it('formats error without patternId', () => {
    const out = alertReason(
      baseAgent(),
      ev({ kind: 'error', patternId: undefined })
    );
    expect(out).toBe('claude-code · Error');
  });
});

describe('alertBody', () => {
  it('prefers detail.cmd (Bash hook)', () => {
    expect(
      alertBody(
        ev({
          kind: 'prompt_detected',
          detail: { tool: 'Bash', cmd: 'rm -rf /tmp/foo' }
        })
      )
    ).toBe('rm -rf /tmp/foo');
  });

  it('uses detail.file_path when no cmd present', () => {
    expect(
      alertBody(
        ev({
          kind: 'prompt_detected',
          detail: { tool: 'Write', file_path: '/etc/passwd' }
        })
      )
    ).toBe('Write: /etc/passwd');
  });

  it('uses detail.args when no cmd / file_path', () => {
    expect(
      alertBody(
        ev({
          kind: 'prompt_detected',
          detail: { tool: 'Read', args: 'src/foo.ts' }
        })
      )
    ).toBe('Read(src/foo.ts)');
  });

  it('uses detail.action for codex/gemini', () => {
    expect(
      alertBody(
        ev({ kind: 'prompt_detected', detail: { action: 'apply patch' } })
      )
    ).toBe('apply patch');
  });

  it('falls back to choices when no detail field set', () => {
    expect(
      alertBody(ev({ kind: 'prompt_detected', choices: ['yes', 'no'] }))
    ).toBe('Choices: yes, no');
  });

  it('falls back to ev.raw as last resort', () => {
    expect(
      alertBody(ev({ kind: 'prompt_detected', raw: 'Run XYZ ?' }))
    ).toBe('Run XYZ ?');
  });

  it('falls back to a generic string if nothing matched', () => {
    expect(alertBody(ev({ kind: 'prompt_detected' }))).toBe(
      'Agent needs your input.'
    );
  });

  it('truncates long bodies to 200 chars', () => {
    const long = 'x'.repeat(500);
    const out = alertBody(ev({ kind: 'prompt_detected', detail: { cmd: long } }));
    expect(out.length).toBe(200);
  });

  it('returns a fixed string for task_done', () => {
    expect(alertBody(ev({ kind: 'task_done' }))).toBe(
      'Agent has finished its task.'
    );
  });

  it('uses detail.message for errors when available', () => {
    expect(
      alertBody(
        ev({ kind: 'error', detail: { message: 'rate limit hit' } })
      )
    ).toBe('rate limit hit');
  });

  it('uses generic body for errors without a message', () => {
    expect(alertBody(ev({ kind: 'error' }))).toBe(
      'Agent encountered an error.'
    );
  });
});
