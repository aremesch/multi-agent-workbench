/**
 * Typed prepared-statement query helpers.
 *
 * Per plan §Drizzle migration readiness, rule 1: this is the ONLY file in the
 * entire codebase that constructs SQL or imports better-sqlite3 (besides
 * index.ts which owns the connection, and migrate.ts which executes raw
 * migration files).
 *
 * Pattern: build a cached prepared statement via getDb() on first call.
 * Statements are lazy because the DB connection is singleton-initialized
 * after config loads — we can't prepare at module load.
 */

import type { Statement } from 'better-sqlite3';
import { getDb } from './index.js';
import type {
  AgentRow,
  AgentRunRow,
  AgentStatus,
  AlertRow,
  AlertSeverity,
  EventRow,
  MessageRow,
  ProjectRow,
  PushSubscriptionRow,
  RepoRow,
  RoleRow,
  SessionRow,
  TaskRow,
  TaskStatus,
  TerminalLogRow,
  UserRow,
  WorktreeRow,
  WorktreeStatus
} from './types.js';

// --------------- prepared statement cache ---------------

const stmtCache = new Map<string, Statement<unknown[], unknown>>();
function prep<P extends unknown[], R = unknown>(sql: string): Statement<P, R> {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().prepare(sql) as Statement<unknown[], unknown>;
    stmtCache.set(sql, s);
  }
  return s as unknown as Statement<P, R>;
}

const now = (): number => Math.floor(Date.now() / 1000);

// --------------- users ---------------

export function getUserByUsername(username: string): UserRow | undefined {
  return prep<[string], UserRow>('SELECT * FROM users WHERE username = ?').get(username);
}

export function getUserById(id: string): UserRow | undefined {
  return prep<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(id);
}

export function countUsers(): number {
  const row = prep<[], { n: number }>('SELECT COUNT(*) AS n FROM users').get();
  return row?.n ?? 0;
}

export function updateUserPasswordHash(userId: string, hash: string): void {
  prep<[string, number, string]>(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?'
  ).run(hash, now(), userId);
}

export function insertUser(row: {
  id: string;
  username: string;
  password_hash: string;
}): void {
  const ts = now();
  prep<[string, string, string, number, number]>(
    'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(row.id, row.username, row.password_hash, ts, ts);
}

// --------------- sessions ---------------

export function getSessionById(id: string): SessionRow | undefined {
  return prep<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?').get(id);
}

export function insertSession(row: {
  id: string;
  user_id: string;
  expires_at: number;
  user_agent: string | null;
}): void {
  const ts = now();
  prep<[string, string, number, string | null, number, number]>(
    'INSERT INTO sessions (id, user_id, expires_at, user_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.id, row.user_id, row.expires_at, row.user_agent, ts, ts);
}

export function deleteSession(id: string): void {
  prep<[string]>('DELETE FROM sessions WHERE id = ?').run(id);
}

export function deleteSessionsForUserExcept(userId: string, keepSessionId: string): void {
  prep<[string, string]>('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(
    userId,
    keepSessionId
  );
}

export function deleteExpiredSessions(): number {
  const info = prep<[number]>('DELETE FROM sessions WHERE expires_at < ?').run(now());
  return info.changes;
}

// --------------- projects ---------------

export function listProjects(userId: string): ProjectRow[] {
  return prep<[string], ProjectRow>(
    'SELECT * FROM projects WHERE user_id = ? ORDER BY name'
  ).all(userId);
}

export function getProject(id: string): ProjectRow | undefined {
  return prep<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?').get(id);
}

export function insertProject(row: {
  id: string;
  user_id: string;
  name: string;
  default_branch: string;
}): void {
  const ts = now();
  prep<[string, string, string, string, number, number]>(
    'INSERT INTO projects (id, user_id, name, default_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.id, row.user_id, row.name, row.default_branch, ts, ts);
}

// --------------- repos ---------------

export function listReposForProject(projectId: string): RepoRow[] {
  return prep<[string], RepoRow>(
    'SELECT * FROM repos WHERE project_id = ? ORDER BY created_at'
  ).all(projectId);
}

export interface RepoWithProjectRow {
  id: string;
  path: string;
  project_name: string;
}

export function listReposWithProjectForUser(userId: string): RepoWithProjectRow[] {
  return prep<[string], RepoWithProjectRow>(
    `SELECT r.id AS id, r.path AS path, p.name AS project_name
       FROM repos r
       JOIN projects p ON p.id = r.project_id
      WHERE r.user_id = ?
      ORDER BY r.path`
  ).all(userId);
}

export function getRepo(id: string): RepoRow | undefined {
  return prep<[string], RepoRow>('SELECT * FROM repos WHERE id = ?').get(id);
}

export function insertRepo(row: {
  id: string;
  user_id: string;
  project_id: string;
  path: string;
  origin_url: string | null;
}): void {
  const ts = now();
  prep<[string, string, string, string, string | null, number, number]>(
    'INSERT INTO repos (id, user_id, project_id, path, origin_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(row.id, row.user_id, row.project_id, row.path, row.origin_url, ts, ts);
}

// --------------- worktrees ---------------

export function getWorktree(id: string): WorktreeRow | undefined {
  return prep<[string], WorktreeRow>('SELECT * FROM worktrees WHERE id = ?').get(id);
}

export function listWorktreesForRepo(repoId: string): WorktreeRow[] {
  return prep<[string], WorktreeRow>(
    'SELECT * FROM worktrees WHERE repo_id = ? ORDER BY created_at'
  ).all(repoId);
}

export function insertWorktree(row: {
  id: string;
  user_id: string;
  repo_id: string;
  path: string;
  branch: string;
  status: WorktreeStatus;
}): void {
  const ts = now();
  prep<[string, string, string, string, string, WorktreeStatus, number, number]>(
    'INSERT INTO worktrees (id, user_id, repo_id, path, branch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(row.id, row.user_id, row.repo_id, row.path, row.branch, row.status, ts, ts);
}

export function updateWorktreeStatus(id: string, status: WorktreeStatus): void {
  prep<[WorktreeStatus, number, string]>(
    'UPDATE worktrees SET status = ?, updated_at = ? WHERE id = ?'
  ).run(status, now(), id);
}

// --------------- roles ---------------

export function listRoles(userId: string): RoleRow[] {
  return prep<[string], RoleRow>(
    'SELECT * FROM roles WHERE user_id = ? ORDER BY name'
  ).all(userId);
}

export function getRole(id: string): RoleRow | undefined {
  return prep<[string], RoleRow>('SELECT * FROM roles WHERE id = ?').get(id);
}

export function insertRole(row: {
  id: string;
  user_id: string;
  name: string;
  system_prompt: string;
  cli_kind: string;
  default_args_json: string;
  tool_config_json: string;
  repo_scope_json: string;
}): void {
  const ts = now();
  prep<[string, string, string, string, string, string, string, string, number, number]>(
    `INSERT INTO roles
       (id, user_id, name, system_prompt, cli_kind, default_args_json, tool_config_json, repo_scope_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.user_id,
    row.name,
    row.system_prompt,
    row.cli_kind,
    row.default_args_json,
    row.tool_config_json,
    row.repo_scope_json,
    ts,
    ts
  );
}

// --------------- agents ---------------

export function getAgent(id: string): AgentRow | undefined {
  return prep<[string], AgentRow>('SELECT * FROM agents WHERE id = ?').get(id);
}

export function listAgentsForUser(userId: string): AgentRow[] {
  return prep<[string], AgentRow>(
    'SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
}

/**
 * Agent row joined with its role name + repo path + project name + current
 * task title for dashboard display. Filtered by the caller-provided status
 * set. Ordered newest-first.
 */
export interface AgentCardRow extends AgentRow {
  role_name: string;
  repo_path: string;
  project_name: string;
  task_title: string | null;
}

export function listAgentCardsForUser(
  userId: string,
  statuses: AgentStatus[]
): AgentCardRow[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(',');
  const sql = `
    SELECT a.*,
           r.name AS role_name,
           rp.path AS repo_path,
           p.name AS project_name,
           t.title AS task_title
    FROM agents a
    JOIN roles r ON r.id = a.role_id
    JOIN repos rp ON rp.id = a.repo_id
    JOIN projects p ON p.id = rp.project_id
    LEFT JOIN tasks t ON t.id = a.current_task_id
    WHERE a.user_id = ? AND a.status IN (${placeholders})
    ORDER BY a.created_at DESC
  `;
  // Cache by the number of placeholders — each arity gets its own prepared stmt.
  return prep<unknown[], AgentCardRow>(sql).all(userId, ...statuses);
}

export function listAgentCardsForRepo(
  userId: string,
  repoId: string,
  statuses: AgentStatus[]
): AgentCardRow[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(',');
  const sql = `
    SELECT a.*,
           r.name AS role_name,
           rp.path AS repo_path,
           p.name AS project_name,
           t.title AS task_title
    FROM agents a
    JOIN roles r ON r.id = a.role_id
    JOIN repos rp ON rp.id = a.repo_id
    JOIN projects p ON p.id = rp.project_id
    LEFT JOIN tasks t ON t.id = a.current_task_id
    WHERE a.user_id = ? AND a.repo_id = ? AND a.status IN (${placeholders})
    ORDER BY a.created_at DESC
  `;
  return prep<unknown[], AgentCardRow>(sql).all(userId, repoId, ...statuses);
}

export function deleteAgent(id: string): void {
  prep<[string]>('DELETE FROM agents WHERE id = ?').run(id);
}

export function listLiveAgents(): AgentRow[] {
  return prep<[], AgentRow>(
    `SELECT * FROM agents
     WHERE status IN ('spawning','running','waiting_input','idle')
     ORDER BY created_at`
  ).all();
}

export function insertAgent(row: {
  id: string;
  user_id: string;
  role_id: string;
  repo_id: string;
  worktree_id: string;
  cli_kind: string;
  tmux_session: string;
  status: AgentStatus;
  cli_session_id: string | null;
}): void {
  const ts = now();
  prep<
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      AgentStatus,
      string | null,
      number,
      number
    ]
  >(
    `INSERT INTO agents
       (id, user_id, role_id, repo_id, worktree_id, cli_kind, tmux_session, status, cli_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.user_id,
    row.role_id,
    row.repo_id,
    row.worktree_id,
    row.cli_kind,
    row.tmux_session,
    row.status,
    row.cli_session_id,
    ts,
    ts
  );
}

export function updateAgentStatus(id: string, status: AgentStatus): void {
  prep<[AgentStatus, number, string]>(
    'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?'
  ).run(status, now(), id);
}

export function updateAgentAttention(id: string, ts: number): void {
  prep<[number, number, string]>(
    'UPDATE agents SET last_attention_at = ?, updated_at = ? WHERE id = ?'
  ).run(ts, now(), id);
}

export function updateAgentCurrentTask(id: string, taskId: string | null): void {
  prep<[string | null, number, string]>(
    'UPDATE agents SET current_task_id = ?, updated_at = ? WHERE id = ?'
  ).run(taskId, now(), id);
}

// --------------- agent runs ---------------

export function insertAgentRun(row: {
  id: string;
  user_id: string;
  agent_id: string;
  started_at: number;
}): void {
  const ts = now();
  prep<[string, string, string, number, number, number]>(
    `INSERT INTO agent_runs (id, user_id, agent_id, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.user_id, row.agent_id, row.started_at, ts, ts);
}

export function closeAgentRun(
  id: string,
  ended_at: number,
  exit_code: number | null,
  reason: string | null
): void {
  prep<[number, number | null, string | null, number, string]>(
    'UPDATE agent_runs SET ended_at = ?, exit_code = ?, reason = ?, updated_at = ? WHERE id = ?'
  ).run(ended_at, exit_code, reason, now(), id);
}

export function listAgentRuns(agentId: string): AgentRunRow[] {
  return prep<[string], AgentRunRow>(
    'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC'
  ).all(agentId);
}

export function getLatestRunForAgent(agentId: string): AgentRunRow | undefined {
  return prep<[string], AgentRunRow>(
    'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1'
  ).get(agentId);
}

export interface TerminalActivitySummary {
  activeSec: number;
  idleSec: number;
  firstTs: number | null;
  lastTs: number | null;
  chunkCount: number;
}

/**
 * Walk an agent's terminal_log chunks in time order, summing the wall-clock
 * gap between consecutive chunks. Gaps shorter than `idleThresholdSec` count
 * as "active" (the agent or user was producing output regularly); longer
 * gaps count as "idle". This is a heuristic — it doesn't distinguish AI
 * output from user keystrokes, but it gives a useful "how busy was this
 * session" signal without any new instrumentation.
 */
export function summarizeTerminalActivity(
  agentId: string,
  idleThresholdSec = 30
): TerminalActivitySummary {
  const rows = prep<[string], { ts: number }>(
    'SELECT ts FROM terminal_log WHERE agent_id = ? ORDER BY seq'
  ).all(agentId);
  if (rows.length === 0) {
    return { activeSec: 0, idleSec: 0, firstTs: null, lastTs: null, chunkCount: 0 };
  }
  let activeSec = 0;
  let idleSec = 0;
  let prev = rows[0]!.ts;
  for (let i = 1; i < rows.length; i++) {
    const cur = rows[i]!.ts;
    const gap = cur - prev;
    prev = cur;
    if (gap <= 0) continue;
    if (gap <= idleThresholdSec) activeSec += gap;
    else idleSec += gap;
  }
  return {
    activeSec,
    idleSec,
    firstTs: rows[0]!.ts,
    lastTs: rows[rows.length - 1]!.ts,
    chunkCount: rows.length
  };
}

export function listAllTerminalChunks(agentId: string): TerminalLogRow[] {
  return prep<[string], TerminalLogRow>(
    'SELECT * FROM terminal_log WHERE agent_id = ? ORDER BY seq'
  ).all(agentId);
}

// --------------- tasks ---------------

export function insertTask(row: {
  id: string;
  user_id: string;
  agent_id: string;
  title: string;
  body: string;
  status: TaskStatus;
  assigned_by_agent_id: string | null;
}): void {
  const ts = now();
  prep<
    [string, string, string, string, string, TaskStatus, string | null, number, number]
  >(
    `INSERT INTO tasks
       (id, user_id, agent_id, title, body, status, assigned_by_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.user_id,
    row.agent_id,
    row.title,
    row.body,
    row.status,
    row.assigned_by_agent_id,
    ts,
    ts
  );
}

export function listTasksForAgent(agentId: string): TaskRow[] {
  return prep<[string], TaskRow>(
    'SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC'
  ).all(agentId);
}

// --------------- terminal log ---------------

export function insertTerminalChunk(row: {
  id: string;
  user_id: string;
  agent_id: string;
  seq: number;
  ts: number;
  chunk: Buffer;
}): void {
  const ts = now();
  prep<[string, string, string, number, number, Buffer, number, number]>(
    `INSERT INTO terminal_log (id, user_id, agent_id, seq, ts, chunk, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.user_id, row.agent_id, row.seq, row.ts, row.chunk, ts, ts);
}

export function getLatestTerminalSeq(agentId: string): number {
  const row = prep<[string], { seq: number | null }>(
    'SELECT MAX(seq) AS seq FROM terminal_log WHERE agent_id = ?'
  ).get(agentId);
  return row?.seq ?? 0;
}

export function listTerminalChunksSince(agentId: string, seq: number): TerminalLogRow[] {
  return prep<[string, number], TerminalLogRow>(
    'SELECT * FROM terminal_log WHERE agent_id = ? AND seq > ? ORDER BY seq'
  ).all(agentId, seq);
}

export function pruneTerminalLogByBytes(agentId: string, maxBytes: number): number {
  // Compute total, delete oldest chunks until under budget. Simple + correct.
  const totalRow = prep<[string], { total: number | null }>(
    'SELECT SUM(LENGTH(chunk)) AS total FROM terminal_log WHERE agent_id = ?'
  ).get(agentId);
  let total = totalRow?.total ?? 0;
  if (total <= maxBytes) return 0;

  const oldest = prep<[string], { id: string; size: number }>(
    'SELECT id, LENGTH(chunk) AS size FROM terminal_log WHERE agent_id = ? ORDER BY seq'
  );
  const del = prep<[string]>('DELETE FROM terminal_log WHERE id = ?');

  let deleted = 0;
  const tx = getDb().transaction(() => {
    for (const row of oldest.iterate(agentId)) {
      if (total <= maxBytes) break;
      del.run(row.id);
      total -= row.size;
      deleted++;
    }
  });
  tx();
  return deleted;
}

// --------------- events ---------------

export function insertEvent(row: {
  id: string;
  user_id: string;
  agent_id: string;
  kind: string;
  payload_json: string;
  ts: number;
}): void {
  const ts = now();
  prep<[string, string, string, string, string, number, number, number]>(
    `INSERT INTO events (id, user_id, agent_id, kind, payload_json, ts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.user_id, row.agent_id, row.kind, row.payload_json, row.ts, ts, ts);
}

export function listEventsForAgent(agentId: string, limit = 100): EventRow[] {
  return prep<[string, number], EventRow>(
    'SELECT * FROM events WHERE agent_id = ? ORDER BY ts DESC LIMIT ?'
  ).all(agentId, limit);
}

// --------------- messages (inter-agent) ---------------

export function insertMessage(row: {
  id: string;
  user_id: string;
  from_agent_id: string | null;
  to_agent_id: string;
  kind: string;
  body: string;
  ts: number;
}): void {
  const ts = now();
  prep<[string, string, string | null, string, string, string, number, number, number]>(
    `INSERT INTO messages
       (id, user_id, from_agent_id, to_agent_id, kind, body, ts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.user_id,
    row.from_agent_id,
    row.to_agent_id,
    row.kind,
    row.body,
    row.ts,
    ts,
    ts
  );
}

export function listInbox(agentId: string, onlyUnread = false): MessageRow[] {
  if (onlyUnread) {
    return prep<[string], MessageRow>(
      'SELECT * FROM messages WHERE to_agent_id = ? AND read_at IS NULL ORDER BY ts'
    ).all(agentId);
  }
  return prep<[string], MessageRow>(
    'SELECT * FROM messages WHERE to_agent_id = ? ORDER BY ts'
  ).all(agentId);
}

export function markMessageRead(id: string): void {
  prep<[number, number, string]>(
    'UPDATE messages SET read_at = ?, updated_at = ? WHERE id = ?'
  ).run(now(), now(), id);
}

// --------------- alerts ---------------

export function insertAlert(row: {
  id: string;
  user_id: string;
  agent_id: string;
  severity: AlertSeverity;
  reason: string;
  payload_json: string;
  ts: number;
}): void {
  const ts = now();
  prep<[string, string, string, AlertSeverity, string, string, number, number, number]>(
    `INSERT INTO alerts
       (id, user_id, agent_id, severity, reason, payload_json, ts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.user_id,
    row.agent_id,
    row.severity,
    row.reason,
    row.payload_json,
    row.ts,
    ts,
    ts
  );
}

export function listRecentAlerts(agentId: string, sinceTs: number): AlertRow[] {
  return prep<[string, number], AlertRow>(
    'SELECT * FROM alerts WHERE agent_id = ? AND ts >= ? ORDER BY ts DESC'
  ).all(agentId, sinceTs);
}

export function acknowledgeAlert(id: string): void {
  prep<[number, number, string]>(
    'UPDATE alerts SET acknowledged_at = ?, updated_at = ? WHERE id = ?'
  ).run(now(), now(), id);
}

// --------------- push subscriptions ---------------

export function listPushSubsForUser(userId: string): PushSubscriptionRow[] {
  return prep<[string], PushSubscriptionRow>(
    'SELECT * FROM push_subscriptions WHERE user_id = ?'
  ).all(userId);
}

export function upsertPushSub(row: {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  ua: string | null;
}): void {
  const ts = now();
  prep<[string, string, string, string, string, string | null, number, number]>(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, ua, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh=excluded.p256dh, auth=excluded.auth, ua=excluded.ua, updated_at=excluded.updated_at`
  ).run(row.id, row.user_id, row.endpoint, row.p256dh, row.auth, row.ua, ts, ts);
}

export function deletePushSubByEndpoint(endpoint: string): void {
  prep<[string]>('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

// --------------- user settings ---------------

export function getUserSetting(userId: string, key: string): string | null {
  const row = prep<[string, string], { value_json: string }>(
    'SELECT value_json FROM user_settings WHERE user_id = ? AND key = ?'
  ).get(userId, key);
  return row?.value_json ?? null;
}

export function setUserSetting(userId: string, key: string, valueJson: string): void {
  const ts = now();
  prep<[string, string, string, number, number]>(
    `INSERT INTO user_settings (user_id, key, value_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`
  ).run(userId, key, valueJson, ts, ts);
}

const SPAWN_DEFAULTS_PREFIX = 'spawn.defaults.';

export function getSpawnDefaults(
  userId: string,
  cliKind: string
): { optionalArgs: Record<string, boolean> } | null {
  const raw = getUserSetting(userId, `${SPAWN_DEFAULTS_PREFIX}${cliKind}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { optionalArgs: Record<string, boolean> };
  } catch {
    return null;
  }
}

export function getSpawnDefaultsAll(
  userId: string,
  cliKinds: string[]
): Record<string, { optionalArgs: Record<string, boolean> }> {
  const result: Record<string, { optionalArgs: Record<string, boolean> }> = {};
  for (const kind of cliKinds) {
    const defaults = getSpawnDefaults(userId, kind);
    if (defaults) result[kind] = defaults;
  }
  return result;
}
