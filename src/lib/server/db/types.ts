/**
 * Row interfaces — the canonical shape of each SQLite table as seen by TS.
 *
 * These are maintained alongside migrations. When we eventually switch to
 * Drizzle (see plan §Drizzle migration readiness) this file becomes a
 * re-export of InferSelectModel<typeof ...> — all downstream imports stay the
 * same shape.
 */

export type CliKind = string;

export type AgentStatus =
  | 'spawning'
  | 'running'
  | 'waiting_input'
  | 'idle'
  | 'exited'
  | 'crashed';

export type WorktreeStatus = 'active' | 'orphaned' | 'removed';
export type TaskStatus = 'queued' | 'active' | 'done' | 'cancelled';
export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  must_change_password: number;
  password_updated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AuthEventRow {
  id: number;
  ts: number;
  event: string;
  user_id: string | null;
  username: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
  user_agent: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  default_branch: string;
  created_at: number;
  updated_at: number;
}

export interface RepoRow {
  id: string;
  user_id: string;
  project_id: string;
  path: string;
  origin_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorktreeRow {
  id: string;
  user_id: string;
  repo_id: string;
  path: string;
  branch: string;
  status: WorktreeStatus;
  created_at: number;
  updated_at: number;
}

export interface RoleRow {
  id: string;
  user_id: string;
  name: string;
  system_prompt: string;
  cli_kind: CliKind;
  default_args_json: string;
  tool_config_json: string;
  repo_scope_json: string;
  created_at: number;
  updated_at: number;
}

export interface AgentRow {
  id: string;
  user_id: string;
  role_id: string;
  repo_id: string;
  worktree_id: string;
  cli_kind: CliKind;
  tmux_session: string;
  status: AgentStatus;
  last_attention_at: number | null;
  current_task_id: string | null;
  cli_session_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentRunRow {
  id: string;
  user_id: string;
  agent_id: string;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskRow {
  id: string;
  user_id: string;
  agent_id: string;
  title: string;
  body: string;
  status: TaskStatus;
  assigned_by_agent_id: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TerminalLogRow {
  id: string;
  user_id: string;
  agent_id: string;
  seq: number;
  ts: number;
  chunk: Buffer;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  id: string;
  user_id: string;
  agent_id: string;
  kind: string;
  payload_json: string;
  ts: number;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  user_id: string;
  from_agent_id: string | null;
  to_agent_id: string;
  kind: string;
  body: string;
  read_at: number | null;
  ts: number;
  created_at: number;
  updated_at: number;
}

export interface AlertRow {
  id: string;
  user_id: string;
  agent_id: string;
  severity: AlertSeverity;
  reason: string;
  payload_json: string;
  ts: number;
  acknowledged_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  ua: string | null;
  created_at: number;
  updated_at: number;
}

export interface LlmOversightVerdictRow {
  id: string;
  user_id: string;
  agent_id: string;
  verdict: string;
  rationale: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  ts: number;
  created_at: number;
  updated_at: number;
}
