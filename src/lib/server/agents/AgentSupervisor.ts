/**
 * AgentSupervisor — singleton registry of live AgentRuntimes + reattach-on-boot.
 *
 * On init(): loads every agent row in a "live" status, checks whether its
 * tmux session still exists, and either re-creates an AgentRuntime (with a
 * fresh FIFO + pipe-pane) or marks it crashed.
 */

import { ulid } from 'ulid';
import { AgentRuntime } from './AgentRuntime.js';
import { AdapterRegistry } from './adapters/AdapterRegistry.js';
import type { AgentRow } from '../db/types.js';
import {
  getAgent,
  getRole,
  insertAgent,
  insertAgentRun,
  listLiveAgents,
  updateAgentStatus
} from '../db/queries.js';
import { Tmux } from '../tmux/TmuxSession.js';
import { WorktreeManager } from '../git/WorktreeManager.js';
import { getConfig } from '../config.js';

export interface SpawnAgentArgs {
  userId: string;
  roleId: string;
  repoId: string;
  repoPath: string;
  worktreeId: string;
  worktreePath: string;
  task: { title: string; body: string } | null;
}

export class AgentSupervisor {
  private runtimes = new Map<string, AgentRuntime>();

  constructor(public readonly registry: AdapterRegistry) {}

  /** Called once at boot. Reattaches to any surviving tmux sessions. */
  async init(): Promise<{ reattached: number; crashed: number }> {
    const cfg = getConfig();
    let reattached = 0;
    let crashed = 0;

    const liveSessions = new Set(await Tmux.listMawSessions());
    const rows = listLiveAgents();

    for (const row of rows) {
      if (!liveSessions.has(row.tmux_session)) {
        updateAgentStatus(row.id, 'crashed');
        crashed++;
        continue;
      }
      try {
        if (!this.registry.has(row.cli_kind)) {
          console.warn(
            `[AgentSupervisor] unknown cli_kind '${row.cli_kind}' for agent ${row.id} — marking crashed`
          );
          updateAgentStatus(row.id, 'crashed');
          crashed++;
          continue;
        }
        const adapter = this.registry.create(row.cli_kind);
        const runtime = new AgentRuntime(row, adapter, cfg.fifoDir);
        await runtime.start();
        this.runtimes.set(row.id, runtime);
        reattached++;
      } catch (err) {
        console.error(`[AgentSupervisor] reattach failed for ${row.id}:`, err);
        updateAgentStatus(row.id, 'crashed');
        crashed++;
      }
    }

    return { reattached, crashed };
  }

  async shutdown(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      await rt.stop();
    }
    this.runtimes.clear();
  }

  get(agentId: string): AgentRuntime | undefined {
    return this.runtimes.get(agentId);
  }

  list(): AgentRuntime[] {
    return Array.from(this.runtimes.values());
  }

  /** Spawn a brand-new agent: insert row, create tmux session, start runtime. */
  async spawn(args: SpawnAgentArgs): Promise<AgentRow> {
    const cfg = getConfig();
    const role = getRole(args.roleId);
    if (!role) throw new Error(`role not found: ${args.roleId}`);
    if (!this.registry.has(role.cli_kind)) {
      throw new Error(`no adapter registered for cli_kind '${role.cli_kind}'`);
    }

    const adapter = this.registry.create(role.cli_kind);
    const spec = adapter.buildSpawnSpec({
      role: {
        systemPrompt: role.system_prompt,
        toolConfig: JSON.parse(role.tool_config_json || '{}')
      },
      worktreeCwd: args.worktreePath,
      task: args.task,
      env: {
        ANTHROPIC_API_KEY: cfg.anthropicApiKey,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
        GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? ''
      }
    });

    const agentId = ulid();
    const tmuxSession = Tmux.sessionName(agentId);

    insertAgent({
      id: agentId,
      user_id: args.userId,
      role_id: role.id,
      repo_id: args.repoId,
      worktree_id: args.worktreeId,
      cli_kind: role.cli_kind,
      tmux_session: tmuxSession,
      status: 'spawning'
    });

    // Merge env: our agent-id/url identity vars go alongside the adapter's.
    const env: Record<string, string> = {
      ...spec.env,
      MAW_AGENT_ID: agentId,
      MAW_URL: `http://${cfg.host}:${cfg.port}`
    };

    await Tmux.newSession({
      session: tmuxSession,
      command: spec.command,
      args: spec.args,
      env,
      cwd: spec.cwd
    });

    const row = getAgent(agentId)!;
    const runtime = new AgentRuntime(row, adapter, cfg.fifoDir);
    await runtime.start();
    this.runtimes.set(agentId, runtime);

    insertAgentRun({
      id: ulid(),
      user_id: args.userId,
      agent_id: agentId,
      started_at: Math.floor(Date.now() / 1000)
    });
    updateAgentStatus(agentId, 'running');

    // Optional initial input after the CLI has had a beat to boot.
    if (spec.initialInput) {
      setTimeout(() => {
        runtime.enqueueInput(spec.initialInput ?? '', true).catch((err) => {
          console.error(`[AgentSupervisor] initialInput failed for ${agentId}:`, err);
        });
      }, 1500);
    }

    return row;
  }

  async kill(agentId: string): Promise<void> {
    const runtime = this.runtimes.get(agentId);
    if (runtime) {
      await runtime.stop();
      this.runtimes.delete(agentId);
    }
    const row = getAgent(agentId);
    if (row) {
      await Tmux.killSession(row.tmux_session);
      updateAgentStatus(agentId, 'exited');
    }
  }
}

/**
 * Helper: try to find an existing worktree or create one. Used by the spawn
 * route when the caller wants "give me a fresh agent in a new branch".
 */
export async function ensureWorktree(
  wtm: WorktreeManager,
  repoPath: string,
  agentId: string,
  branch: string
): Promise<string> {
  return wtm.create({ repoPath, agentId, branch });
}
