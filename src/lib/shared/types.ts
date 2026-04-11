/**
 * Types shared between server load functions and client components.
 * These must not import any server-only modules so they can be pulled into
 * client bundles without leaking node deps.
 */

export type AgentStatus =
  | 'spawning'
  | 'running'
  | 'waiting_input'
  | 'idle'
  | 'exited'
  | 'crashed';

/**
 * Agent row enriched with role name + repo path + project name for
 * dashboard display. Matches the shape returned by `listAgentCardsForUser`
 * in queries.ts.
 */
export interface AgentCardRow {
  id: string;
  user_id: string;
  role_id: string;
  repo_id: string;
  worktree_id: string;
  cli_kind: string;
  tmux_session: string;
  status: AgentStatus;
  last_attention_at: number | null;
  current_task_id: string | null;
  created_at: number;
  updated_at: number;
  role_name: string;
  repo_path: string;
  project_name: string;
  task_title: string | null;
}

/** Persisted gridstack position for one agent card. */
export interface LayoutEntry {
  agentId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
