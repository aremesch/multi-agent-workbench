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
  /**
   * Pre-generated agent id. Must match the ulid the caller used to name the
   * worktree directory and branch so everything stays in lock-step.
   */
  agentId: string;
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
  /**
   * One `tmux wait-for` subprocess per live agent. Resolves the instant the
   * session-closed hook fires, giving us event-driven exit detection with
   * no polling. Tracked here so we can kill the waiter cleanly when an
   * agent is reaped via some other path (shutdown, explicit kill, snapshot
   * 410, …) — otherwise we'd leak a subprocess per dead agent.
   */
  private exitWaiters = new Map<string, ReturnType<typeof Tmux.spawnWaitForChannel>>();

  constructor(public readonly registry: AdapterRegistry) {}

  /**
   * Install a per-session `session-closed` hook on tmux that signals a
   * unique wait-for channel, then fork a blocking `tmux wait-for` client
   * that resolves the moment tmux fires the hook. When it resolves we
   * reap the agent immediately — so Ctrl-D twice in a shell closes the
   * terminal modal in single-digit milliseconds, without any polling.
   *
   * Set the hook *first* and then start the waiter: both happen while the
   * session is still alive (we've only just spawned/reattached it), so
   * there's no race where the hook could fire before the waiter exists.
   * Errors are non-fatal — the periodic reaper in bootstrap.ts is still
   * the safety net for edge cases (tmux server restart, external hook
   * clearing, external kill-session, …).
   */
  private startExitWatcher(agentId: string, session: string): void {
    const channel = `maw-exit-${agentId}`;
    Tmux.setSessionClosedSignal(session, channel).catch((err) => {
      console.warn(`[AgentSupervisor] set-hook failed for ${agentId}:`, err);
    });
    const proc = Tmux.spawnWaitForChannel(channel);
    this.exitWaiters.set(agentId, proc);
    proc.then(
      async () => {
        this.exitWaiters.delete(agentId);
        const rt = this.runtimes.get(agentId);
        if (!rt) return;
        // Guard against stale pre-signaled tmux channels from a previous
        // backend run: if the session is still alive, the channel fired
        // spuriously (e.g. a previous `wait-for` was killed before consuming
        // the signal). Log and let the periodic reaper handle real exits.
        if (await Tmux.hasSession(rt.tmuxSession)) {
          console.warn(
            `[AgentSupervisor] exit-watcher fired for live session ${agentId} — ignoring (stale channel?)`
          );
          return;
        }
        this.finishAsExited(agentId, rt).catch((err) => {
          console.error(`[AgentSupervisor] exit-watcher finish failed for ${agentId}:`, err);
        });
      },
      () => {
        // Killed via stopExitWatcher (another reap path beat us to it) OR
        // the tmux server went away. Either way the periodic reaper will
        // clean up anything that slipped through.
        this.exitWaiters.delete(agentId);
      }
    );
  }

  /**
   * Abort a live exit-watcher subprocess. Called whenever the agent is
   * being reaped through a different code path so we don't leak the
   * blocked `tmux wait-for` child. Safe to call when no waiter exists.
   */
  private stopExitWatcher(agentId: string): void {
    const proc = this.exitWaiters.get(agentId);
    if (!proc) return;
    this.exitWaiters.delete(agentId);
    try {
      proc.kill();
    } catch {
      // ignore — already exited
    }
  }

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
        this.startExitWatcher(row.id, row.tmux_session);
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
    for (const agentId of Array.from(this.exitWaiters.keys())) {
      this.stopExitWatcher(agentId);
    }
    for (const rt of this.runtimes.values()) {
      await rt.stop();
    }
    this.runtimes.clear();
  }

  /**
   * Check every live runtime against the set of surviving tmux sessions and
   * transition any whose session has disappeared into `exited`. This is how
   * an agent that the user quit from inside the CLI (e.g. typing `/exit` in
   * claude code) gets moved out of the dashboard into the archive: the CLI
   * exits → sh exits → tmux session dies → we notice here and flip status.
   *
   * Also stops the runtime (tears down fifo + pipe-pane) and removes it from
   * the in-memory registry so we don't leak FDs.
   */
  async reap(): Promise<number> {
    if (this.runtimes.size === 0) return 0;
    const liveSessions = new Set(await Tmux.listMawSessions());
    let reaped = 0;
    for (const [agentId, runtime] of Array.from(this.runtimes.entries())) {
      if (!liveSessions.has(runtime.tmuxSession)) {
        await this.finishAsExited(agentId, runtime);
        reaped++;
      }
    }
    return reaped;
  }

  /**
   * Force the "session ended" transition for a single agent. Used by the
   * snapshot API route the moment it detects a dead session — so the UI sees
   * the agent move to the archive on its very next poll, without having to
   * wait up to a full reap-loop interval.
   */
  async reapAgent(agentId: string): Promise<boolean> {
    const runtime = this.runtimes.get(agentId);
    if (!runtime) return false;
    if (await Tmux.hasSession(runtime.tmuxSession)) return false;
    await this.finishAsExited(agentId, runtime);
    return true;
  }

  private async finishAsExited(agentId: string, runtime: AgentRuntime): Promise<void> {
    this.stopExitWatcher(agentId);
    try {
      await runtime.stop();
    } catch (err) {
      console.error(`[AgentSupervisor] reap: stop failed for ${agentId}:`, err);
    }
    this.runtimes.delete(agentId);
    updateAgentStatus(agentId, 'exited');
    // Notify anyone still subscribed to this runtime (e.g. an open terminal
    // modal on the dashboard) so their UI can react immediately — without
    // this emit, clients only learn the agent ended on their next snapshot
    // poll, which means the modal stays stuck until the user closes it.
    runtime.emit('state', 'exited');
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

    const agentId = args.agentId;
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
    this.startExitWatcher(agentId, tmuxSession);

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
    this.stopExitWatcher(agentId);
    const runtime = this.runtimes.get(agentId);
    if (runtime) {
      await runtime.stop();
      this.runtimes.delete(agentId);
    }
    const row = getAgent(agentId);
    if (row) {
      await Tmux.killSession(row.tmux_session);
      updateAgentStatus(agentId, 'exited');
      runtime?.emit('state', 'exited');
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
