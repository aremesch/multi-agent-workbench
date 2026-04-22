/**
 * AgentSupervisor — singleton registry of live AgentRuntimes + reattach-on-boot.
 *
 * On init(): loads every agent row in a "live" status, checks whether its
 * tmux session still exists, and either re-creates an AgentRuntime (with a
 * fresh FIFO + pipe-pane) or marks it crashed.
 */

import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import { AgentRuntime } from './AgentRuntime.js';
import { AdapterRegistry } from './adapters/AdapterRegistry.js';
import type { AgentRow } from '../db/types.js';
import {
  getAgent,
  getRepo,
  getRole,
  getUserSetting,
  insertAgent,
  insertAgentRun,
  insertAlert,
  listLiveAgents,
  updateAgentStatus
} from '../db/queries.js';
import { getPushService } from '../bootstrap.js';
import { PUSH_PREFS_KEY, DEFAULT_NOTIFY_KINDS, parseNotifyKinds } from '../push/pushPrefs.js';
import { Tmux } from '../tmux/TmuxSession.js';
import { WorktreeManager } from '../git/WorktreeManager.js';
import { snapshotAgentCommits } from '../git/commitSnapshot.js';
import { getConfig } from '../config.js';
import { resolveGitIdentityForUser } from '../user/gitIdentity.js';

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
  /**
   * Resolved SHA of the worktree's start point (project.default_branch at
   * the moment `git worktree add` ran). Anchors commit attribution so it
   * survives `main` moving later. Null when resolving the SHA failed
   * (unborn repo, odd default branch) — snapshotter falls back to merge-base.
   */
  baseSha: string | null;
  task: { title: string; body: string } | null;
  /** Per-spawn optional arg overrides keyed by optionalArg id. */
  optionalArgs?: Record<string, boolean>;
}

export class AgentSupervisor {
  private runtimes = new Map<string, AgentRuntime>();
  /**
   * Latched to true when the process begins shutting down. All paths that
   * would flip a DB row to `exited` (periodic reaper, exit-watcher success)
   * MUST short-circuit once this is set. Reason: systemd's default
   * `KillMode=control-group` sends SIGTERM to every PID in maw.service's
   * cgroup, including any tmux CLI child of node mid-`list-sessions`.
   * `Tmux.listMawSessions()` catches the error and returns []; without
   * this guard the reaper concludes all sessions died and writes
   * `exited` to every live agent — orphaning them across restart.
   */
  private shuttingDown = false;

  markShuttingDown(): void {
    this.shuttingDown = true;
  }
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
   * Fork a blocking `tmux wait-for` client on the per-session exit channel
   * that the server-wide `session-closed` hook signals. The waiter
   * resolves the moment tmux fires the hook for *this* session — so
   * Ctrl-D twice in a shell closes the terminal modal in single-digit
   * milliseconds, without any polling.
   *
   * The channel is derived from the tmux session name
   * (`maw-exit-<session>`), not the agent id, so it matches the format-
   * expanded channel the global hook emits via `#{hook_session_name}`.
   *
   * We re-assert the global hook here (idempotent `set-hook -g` replace)
   * rather than trust the one-shot install in `init()`. In dev the `-L maw`
   * server isn't running at bootstrap time — it only comes up on the first
   * `new-session` — so init's set-hook call fails with "no server running".
   * Reattach and first-spawn both call startExitWatcher after the server
   * is guaranteed to exist, so pinning the hook here is the reliable spot.
   *
   * Errors are non-fatal — the periodic reaper in bootstrap.ts is still
   * the safety net for edge cases (tmux server restart, external hook
   * clearing, external kill-session, …).
   */
  private startExitWatcher(agentId: string, session: string): void {
    Tmux.ensureGlobalSessionClosedHook().catch((err) => {
      console.warn(`[AgentSupervisor] set-hook failed (hook is on -g, one attempt per agent start — reap is fallback):`, err);
    });
    const channel = Tmux.exitChannel(session);
    const proc = Tmux.spawnWaitForChannel(channel);
    this.exitWaiters.set(agentId, proc);
    proc.then(
      () => {
        this.exitWaiters.delete(agentId);
        if (this.shuttingDown) return;
        const rt = this.runtimes.get(agentId);
        if (!rt) return;
        // tmux only fires `session-closed` once the session is really
        // gone, so the hook firing is authoritative. Reap immediately.
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

    // Install the server-wide session-closed hook BEFORE we start any exit
    // waiters. The hook signals `maw-exit-<session>` when any session
    // closes; each per-agent `wait-for` resolves only on its own channel.
    // See `Tmux.ensureGlobalSessionClosedHook` for the why (the per-session
    // variant is fundamentally broken for `session-closed`).
    //
    // In dev the `-L maw` server usually isn't up yet at init() — it
    // auto-spawns on the first `new-session`. `assertServerRunning()` has
    // already printed the info hint in that case, and `startExitWatcher`
    // re-asserts the hook (idempotent) once the server exists, so swallow
    // those two stderr variants silently. Anything else is a real warn.
    await Tmux.ensureGlobalSessionClosedHook().catch((err) => {
      const stderr =
        typeof (err as { stderr?: unknown })?.stderr === 'string'
          ? ((err as { stderr: string }).stderr)
          : '';
      if (/no server running/i.test(stderr) || /no such file or directory/i.test(stderr)) return;
      console.warn('[AgentSupervisor] ensure global session-closed hook failed:', err);
    });

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
    if (this.shuttingDown) return 0;
    if (this.runtimes.size === 0) return 0;
    const liveSessions = new Set(await Tmux.listMawSessions());
    if (this.shuttingDown) return 0;
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
    // Delete-first so concurrent reap paths (periodic reaper, explicit
    // kill, snapshot-410) see the agent is already being finalized and
    // bail out — avoids double stop()/status-flip races.
    if (!this.runtimes.has(agentId)) return;
    this.runtimes.delete(agentId);
    this.stopExitWatcher(agentId);
    const agent = runtime.agent;
    try {
      await runtime.stop();
    } catch (err) {
      console.error(`[AgentSupervisor] reap: stop failed for ${agentId}:`, err);
    }
    updateAgentStatus(agentId, 'exited');
    // Notify anyone still subscribed to this runtime (e.g. an open terminal
    // modal on the dashboard) so their UI can react immediately — without
    // this emit, clients only learn the agent ended on their next snapshot
    // poll, which means the modal stays stuck until the user closes it.
    runtime.emit('state', 'exited');

    // Snapshot git commits into agent_commits. Fire-and-forget: UI status
    // transitions are instant regardless of git latency.
    snapshotAgentCommits(agentId)
      .then((r) => {
        if ('error' in r) {
          console.warn(`[AgentSupervisor] commit snapshot failed for ${agentId}: ${r.error}`);
        } else {
          console.log(
            `[AgentSupervisor] captured ${r.captured} commits for ${agentId} (${r.source})`
          );
        }
      })
      .catch(() => {});

    // Push notification for agent exit.
    const kinds = parseNotifyKinds(getUserSetting(agent.user_id, PUSH_PREFS_KEY));
    if (kinds.includes('exited')) {
      const alertId = ulid();
      const nowTs = Math.floor(Date.now() / 1000);
      const repo = getRepo(agent.repo_id);
      const repoName = repo?.path.split('/').pop() ?? 'repo';
      insertAlert({
        id: alertId,
        user_id: agent.user_id,
        agent_id: agentId,
        severity: 'warning',
        reason: 'Agent exited',
        payload_json: '{}',
        ts: nowTs
      });
      runtime.emit('alert', { id: alertId, agentId, severity: 'warning', reason: 'Agent exited' });
      getPushService().notifyUser(agent.user_id, {
        title: `${agent.cli_kind}: Agent exited`,
        body: `Agent in ${repoName} has stopped.`,
        data: { agentId, alertId, url: `/repos/${agent.repo_id}?agent=${agentId}` }
      }).catch(() => {});
    }
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
    const agentId = args.agentId;
    // Mint a CLI-side session id only when the adapter advertises a history
    // source that needs one. Currently that's `claude-jsonl` — the UUID gets
    // both fed to `claude --session-id` (via {{agent.cliSessionId}}
    // substitution) and stored on the row so the JSONL path is reproducible
    // across server restarts.
    const cliSessionId = adapter.historySource ? randomUUID() : null;
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
      },
      agent: { id: agentId, cliSessionId },
      optionalArgs: args.optionalArgs
    });

    const tmuxSession = Tmux.sessionName(agentId);
    // Distinctive per-agent committer identity anchors attribution in
    // `agent_commits` (commitSnapshot keys on committer_email). Author is
    // the logged-in user's configured git identity so PR UIs / public
    // history show them, not the MAW ops user.
    const committerEmail = `${agentId}@maw.local`;
    const committerName = `MAW-Agent-${agentId}`;
    const authorIdentity = resolveGitIdentityForUser(args.userId);

    insertAgent({
      id: agentId,
      user_id: args.userId,
      role_id: role.id,
      repo_id: args.repoId,
      worktree_id: args.worktreeId,
      cli_kind: role.cli_kind,
      tmux_session: tmuxSession,
      status: 'spawning',
      cli_session_id: cliSessionId,
      base_sha: args.baseSha,
      committer_email: committerEmail
    });

    // Merge env: our agent-id/url identity vars go alongside the adapter's.
    const env: Record<string, string> = {
      ...spec.env,
      MAW_AGENT_ID: agentId,
      MAW_URL: `http://${cfg.host}:${cfg.port}`,
      GIT_COMMITTER_NAME: committerName,
      GIT_COMMITTER_EMAIL: committerEmail,
      GIT_AUTHOR_NAME: authorIdentity.name,
      GIT_AUTHOR_EMAIL: authorIdentity.email
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
      snapshotAgentCommits(agentId)
        .then((r) => {
          if ('error' in r) {
            console.warn(`[AgentSupervisor] commit snapshot failed for ${agentId}: ${r.error}`);
          }
        })
        .catch(() => {});
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
): Promise<{ path: string; baseSha: string | null }> {
  return wtm.create({ repoPath, agentId, branch });
}
