/**
 * QueueScheduler — process-wide singleton that promotes pending queue
 * entries to running agents.
 *
 * Triggers a tick on:
 *   - agent termination (`AgentSupervisor.onAgentTerminated`)
 *   - explicit `scheduleTick()` from API routes (create / edit / cancel /
 *     reorder)
 *   - the earliest future `scheduled_for` deadline (single setTimeout,
 *     re-armed at the end of every tick)
 *   - bootstrap (one-shot, after the supervisor has reattached)
 *
 * The tick is debounced (50 ms) and serialized through an in-process async
 * mutex — multiple events fired close together collapse into a single body
 * of work, and `supervisor.spawn()`'s I/O can't double-promote.
 *
 * Status transitions written by the scheduler:
 *   pending → blocked  (deps / scheduled_for / soft validation failure)
 *   pending → ready    (eligible)
 *   blocked → ready    (deps / time satisfied)
 *   ready   → running  (promoted; supervisor.spawn succeeded)
 *   ready   → failed   (permanent validation failure: role/repo/branch gone)
 *   running → done     (linked agent exited normally)
 *   running → failed   (linked agent crashed, or supervisor.spawn threw)
 *   *       → cancelled (user cancelled via API)
 */

import { EventEmitter } from 'node:events';
import {
  AgentSupervisor,
  type AgentTerminationListener
} from '../agents/AgentSupervisor.js';
import {
  earliestQueuedScheduledFor,
  getAgent,
  getQueueEntry,
  getQueueEntryByAgentId,
  getQueueEntryForUser,
  getQueueConcurrency,
  listLiveAgents,
  listQueueEntriesByIds,
  listSchedulableQueueEntries,
  listUserIds,
  setQueueEntryQueued,
  updateQueueEntryStatus
} from '../db/queries.js';
import type { QueueEntryRow, QueueEntryStatus } from '../db/types.js';
import {
  performSpawn,
  validateSpawnInputs,
  type RawSpawnInputs,
  type SpawnError
} from '../agents/spawnFromInputs.js';

const DEBOUNCE_MS = 50;
const now = (): number => Math.floor(Date.now() / 1000);

/** Live (non-terminal) agent statuses — anything that counts toward the
 *  per-repo concurrency cap. */
const LIVE_AGENT_STATUSES = new Set(['spawning', 'running', 'waiting_input', 'idle']);

/** Status values the scheduler considers terminal across all subsequent
 *  ticks. Anything not in this set is "open" for re-evaluation. */
const TERMINAL_QUEUE_STATUSES: ReadonlySet<QueueEntryStatus> = new Set([
  'done',
  'failed',
  'cancelled'
]);

export interface SchedulerChangeEvent {
  entry: QueueEntryRow;
  /** True when this change was a promotion (status went to 'running'). */
  promoted: boolean;
}

/**
 * Typed listener registration around a plain EventEmitter. WS layer (and
 * tests) subscribe to 'change' and re-broadcast to sockets owned by the
 * affected user (entries.user_id).
 */
export class QueueSchedulerEvents {
  private readonly inner = new EventEmitter();

  on(event: 'change', listener: (e: SchedulerChangeEvent) => void): () => void {
    this.inner.on(event, listener as (...args: unknown[]) => void);
    return () => this.inner.off(event, listener as (...args: unknown[]) => void);
  }

  emit(event: 'change', payload: SchedulerChangeEvent): void {
    this.inner.emit(event, payload);
  }

  removeAllListeners(): void {
    this.inner.removeAllListeners();
  }
}

export class QueueScheduler {
  readonly events = new QueueSchedulerEvents();

  private supervisor: AgentSupervisor | null = null;
  private supervisorListener: (() => void) | null = null;

  private debounceTimer: NodeJS.Timeout | null = null;
  private scheduledForTimer: NodeJS.Timeout | null = null;

  private running = false;
  private rerunRequested = false;
  private stopped = false;

  /**
   * Wire into the supervisor's termination signal, reconcile any orphaned
   * `running` entries (linked agent already terminal — e.g. process restart),
   * and queue the first tick.
   */
  async start(supervisor: AgentSupervisor): Promise<void> {
    if (this.supervisor) throw new Error('QueueScheduler.start: already started');
    this.supervisor = supervisor;
    const listener: AgentTerminationListener = (agentId, terminalStatus) => {
      this.onAgentTerminated(agentId, terminalStatus);
    };
    this.supervisorListener = supervisor.onAgentTerminated(listener);
    await this.reconcileOrphanedRunning();
    this.scheduleTick();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.scheduledForTimer) {
      clearTimeout(this.scheduledForTimer);
      this.scheduledForTimer = null;
    }
    if (this.supervisorListener) {
      this.supervisorListener();
      this.supervisorListener = null;
    }
    this.supervisor = null;
  }

  /** Trigger a debounced tick. Multiple calls within DEBOUNCE_MS collapse. */
  scheduleTick(): void {
    if (this.stopped) return;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.tick().catch((err) => {
        console.error('[QueueScheduler] tick failed:', err);
      });
    }, DEBOUNCE_MS);
  }

  /**
   * Cancel an entry. If it's currently running, also kill the linked agent.
   * Order matters: write the cancelled status before killing the agent so
   * the termination listener's reconcile path sees status !== 'running' and
   * leaves it alone.
   */
  async cancelEntry(entryId: string, userId: string): Promise<boolean> {
    const entry = getQueueEntryForUser(entryId, userId);
    if (!entry) return false;
    if (TERMINAL_QUEUE_STATUSES.has(entry.status)) return false;
    const wasRunning = entry.status === 'running';
    const ts = now();
    updateQueueEntryStatus(entryId, {
      status: 'cancelled',
      completed_at: ts,
      last_error: null
    });
    if (wasRunning && entry.agent_id && this.supervisor) {
      try {
        await this.supervisor.kill(entry.agent_id);
      } catch (err) {
        console.warn(
          `[QueueScheduler] kill linked agent ${entry.agent_id} failed:`,
          (err as Error).message
        );
      }
    }
    const refreshed = getQueueEntry(entryId);
    if (refreshed) this.events.emit('change', { entry: refreshed, promoted: false });
    this.scheduleTick();
    return true;
  }

  /**
   * Move an entry from the backlog into the queue (queued=1). Valid only on
   * pending/blocked/ready rows. Returns false when the row isn't owned by the
   * user, is already terminal, or is currently running.
   */
  queueEntry(entryId: string, userId: string): boolean {
    const ok = setQueueEntryQueued(entryId, userId, true);
    if (!ok) return false;
    const refreshed = getQueueEntry(entryId);
    if (refreshed) this.events.emit('change', { entry: refreshed, promoted: false });
    this.scheduleTick();
    return true;
  }

  /**
   * Move an entry from the queue into the backlog (queued=0). Same guard as
   * `queueEntry` — only valid on non-running, non-terminal rows.
   */
  backlogEntry(entryId: string, userId: string): boolean {
    const ok = setQueueEntryQueued(entryId, userId, false);
    if (!ok) return false;
    const refreshed = getQueueEntry(entryId);
    if (refreshed) this.events.emit('change', { entry: refreshed, promoted: false });
    this.scheduleTick();
    return true;
  }

  /**
   * Promote an entry NOW, bypassing slot caps but still respecting validation
   * and exclusive locking. Used from the queue UI's "run now" action.
   */
  async promoteEntry(entryId: string, userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = getQueueEntryForUser(entryId, userId);
    if (!entry) return { ok: false, error: 'unknown entry' };
    if (entry.status === 'running') return { ok: false, error: 'already running' };
    if (TERMINAL_QUEUE_STATUSES.has(entry.status)) {
      return { ok: false, error: 'already finished' };
    }
    const supervisor = this.supervisor;
    if (!supervisor) return { ok: false, error: 'scheduler not started' };

    // Exclusive lock check — even manual promote should not stomp on a
    // currently-exclusive agent on the same repo.
    const liveOnRepo = await this.collectLiveAgentSet(userId);
    const repoSet = liveOnRepo.byRepo.get(entry.repo_id) ?? [];
    const exclusiveAgentRunning = repoSet.some((a) => a.exclusiveLocked);
    if (exclusiveAgentRunning) {
      return { ok: false, error: 'repo has an exclusive agent running' };
    }
    if ((entry.exclusive === 1 || entry.with_worktree === 0) && repoSet.length > 0) {
      return { ok: false, error: 'this entry requires the repo to be idle' };
    }

    return this.promoteOne(entry).then((res) =>
      res.ok ? { ok: true } : { ok: false, error: res.errorMessage }
    );
  }

  // ------------------------------------------------------------------ tick

  /**
   * Bootstrap-time reconciliation: any queue entry with status='running'
   * whose linked agent is already terminal (process restarted mid-run) is
   * flipped to `done`/`failed` so the scheduler doesn't think the slot is
   * still busy.
   */
  private async reconcileOrphanedRunning(): Promise<void> {
    for (const userId of listUserIds()) {
      const entries = listSchedulableQueueEntries(userId);
      for (const entry of entries) {
        if (entry.status !== 'running' || !entry.agent_id) continue;
        const agent = getAgent(entry.agent_id);
        if (!agent) {
          // Agent row vanished (shouldn't happen with FK SET NULL, but be safe).
          updateQueueEntryStatus(entry.id, {
            status: 'failed',
            last_error: 'linked agent missing on reattach',
            completed_at: now()
          });
          continue;
        }
        if (!LIVE_AGENT_STATUSES.has(agent.status)) {
          const status: QueueEntryStatus = agent.status === 'crashed' ? 'failed' : 'done';
          updateQueueEntryStatus(entry.id, {
            status,
            completed_at: now(),
            last_error: status === 'failed' ? 'linked agent crashed' : null
          });
        }
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      // Loop while any tick body schedules another (rare: promotion that
      // immediately unblocks a downstream dependency).
      do {
        this.rerunRequested = false;
        await this.tickOnce();
      } while (this.rerunRequested && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async tickOnce(): Promise<void> {
    for (const userId of listUserIds()) {
      await this.tickForUser(userId);
    }
    this.armScheduledForTimer();
  }

  private armScheduledForTimer(): void {
    if (this.scheduledForTimer) {
      clearTimeout(this.scheduledForTimer);
      this.scheduledForTimer = null;
    }
    if (this.stopped) return;
    const ts = now();
    let earliest: number | null = null;
    for (const userId of listUserIds()) {
      const candidate = earliestQueuedScheduledFor(userId, ts);
      if (candidate !== null && (earliest === null || candidate < earliest)) {
        earliest = candidate;
      }
    }
    if (earliest === null) return;
    // setTimeout takes ms; cap at ~24h to avoid platform quirks with very
    // large delays. If the deadline is further away than that, we'll
    // re-arm later anyway after some other event.
    const delayMs = Math.min(Math.max((earliest - ts) * 1000, 1000), 24 * 3600 * 1000);
    this.scheduledForTimer = setTimeout(() => {
      this.scheduledForTimer = null;
      this.scheduleTick();
    }, delayMs).unref();
  }

  private async tickForUser(userId: string): Promise<void> {
    const supervisor = this.supervisor;
    if (!supervisor) return;
    // Backlog entries (queued=0) sit on the task list but are excluded from
    // auto-promotion until the user explicitly queues them. Dependencies on
    // backlog entries are surfaced via `last_error` in classifyOpenEntry.
    const entries = listSchedulableQueueEntries(userId, { onlyQueued: true });
    if (entries.length === 0) return;

    // 1. Refresh blocked / ready classification for open entries.
    const ts = now();
    const entryById = new Map<string, QueueEntryRow>();
    for (const e of entries) entryById.set(e.id, e);

    for (const entry of entries) {
      if (entry.status !== 'pending' && entry.status !== 'blocked' && entry.status !== 'ready') {
        continue;
      }
      const classification = this.classifyOpenEntry(entry, ts, entryById, userId);
      if (classification.status !== entry.status || classification.last_error !== entry.last_error) {
        updateQueueEntryStatus(entry.id, {
          status: classification.status,
          last_error: classification.last_error
        });
        entry.status = classification.status;
        entry.last_error = classification.last_error;
        const refreshed = getQueueEntry(entry.id);
        if (refreshed) this.events.emit('change', { entry: refreshed, promoted: false });
      }
    }

    // 2. Slot accounting.
    const concurrency = getQueueConcurrency(userId);
    const liveAgents = await this.collectLiveAgentSet(userId);
    const ready = entries.filter((e) => e.status === 'ready');
    if (ready.length === 0) return;
    let runningGlobal = entries.filter((e) => e.status === 'running').length;

    // 3. Order ready by priority desc, created_at asc. Already sorted by
    // listSchedulableQueueEntries, but ready is a subset; preserve order.
    for (const entry of ready) {
      if (this.stopped) return;
      if (runningGlobal >= concurrency.maxConcurrentGlobal) break;
      const repoCap = concurrency.perRepoOverrides[entry.repo_id] ?? concurrency.maxConcurrentPerRepo;
      const repoSet = liveAgents.byRepo.get(entry.repo_id) ?? [];
      const exclusiveAgentRunning = repoSet.some((a) => a.exclusiveLocked);
      if (exclusiveAgentRunning) continue;
      const entryWantsExclusive = entry.exclusive === 1 || entry.with_worktree === 0;
      if (entryWantsExclusive && repoSet.length > 0) continue;
      if (!entryWantsExclusive && repoSet.length >= repoCap) continue;

      // Eligible — promote.
      const res = await this.promoteOne(entry);
      if (res.ok) {
        runningGlobal++;
        // Account the new agent in the live set so subsequent loop iterations
        // see the slot as used.
        const newAgent: LiveAgent = {
          agentId: res.agentId,
          repoId: entry.repo_id,
          exclusiveLocked: entry.exclusive === 1 || entry.with_worktree === 0
        };
        const arr = liveAgents.byRepo.get(entry.repo_id) ?? [];
        arr.push(newAgent);
        liveAgents.byRepo.set(entry.repo_id, arr);
      }
    }
  }

  private classifyOpenEntry(
    entry: QueueEntryRow,
    ts: number,
    entryById: Map<string, QueueEntryRow>,
    userId: string
  ): { status: QueueEntryStatus; last_error: string | null } {
    let deps: string[] = [];
    try {
      const parsed = JSON.parse(entry.depends_on_json);
      if (Array.isArray(parsed)) deps = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // malformed deps json — treat as no deps but flag the error
      return { status: 'blocked', last_error: 'invalid depends_on_json' };
    }
    if (deps.length > 0) {
      // Look up missing deps (e.g. cross-batch OR backlog deps that the tick's
      // queued-only filter doesn't surface) so we can detect failures and tell
      // the user when their dep is parked in the backlog.
      const missingIds = deps.filter((id) => !entryById.has(id));
      const extra = missingIds.length > 0 ? listQueueEntriesByIds(missingIds, userId) : [];
      for (const e of extra) entryById.set(e.id, e);
      for (const depId of deps) {
        const dep = entryById.get(depId);
        if (!dep) {
          return { status: 'blocked', last_error: `dependency missing: ${depId}` };
        }
        if (dep.status === 'failed' || dep.status === 'cancelled') {
          return {
            status: 'blocked',
            last_error: `dependency ${dep.status}: ${dep.id}`
          };
        }
        if (dep.queued === 0 && dep.status !== 'done') {
          return {
            status: 'blocked',
            last_error: `dependency in backlog: ${dep.id}`
          };
        }
        if (dep.status !== 'done') {
          return { status: 'blocked', last_error: null };
        }
      }
    }
    if (entry.scheduled_for !== null && entry.scheduled_for > ts) {
      return { status: 'blocked', last_error: null };
    }
    return { status: 'ready', last_error: null };
  }

  private async collectLiveAgentSet(userId: string): Promise<LiveAgentSet> {
    const agents = listLiveAgents().filter((a) => a.user_id === userId);
    const byRepo = new Map<string, LiveAgent[]>();
    for (const agent of agents) {
      const linkedEntry = getQueueEntryByAgentId(agent.id);
      const exclusiveLocked = linkedEntry
        ? linkedEntry.exclusive === 1 || linkedEntry.with_worktree === 0
        : false;
      const live: LiveAgent = {
        agentId: agent.id,
        repoId: agent.repo_id,
        exclusiveLocked
      };
      const arr = byRepo.get(agent.repo_id) ?? [];
      arr.push(live);
      byRepo.set(agent.repo_id, arr);
    }
    return { byRepo };
  }

  // ------------------------------------------------------------ promotion

  private async promoteOne(
    entry: QueueEntryRow
  ): Promise<{ ok: true; agentId: string } | { ok: false; errorMessage: string }> {
    const supervisor = this.supervisor;
    if (!supervisor) return { ok: false, errorMessage: 'scheduler not started' };

    // Re-validate against the current DB / registry state — between save
    // and promote the user may have deleted the role or renamed the repo.
    const raw: RawSpawnInputs = {
      roleId: entry.role_id,
      repoId: entry.repo_id,
      taskTitle: entry.title,
      taskBody: entry.body ?? '',
      targetUrl: entry.target_url ?? '',
      branch: entry.source_branch ?? '',
      withWorktreeExplicit: entry.with_worktree === 1,
      model: entry.model,
      permissionMode: entry.permission_mode,
      optionalArgs: this.parseOptionalArgs(entry.optional_args_json),
      planMd: entry.plan_md
    };
    const validation = await validateSpawnInputs(raw, entry.user_id, supervisor.registry, {
      verifyBranchExists: true
    });
    if (!validation.ok) {
      const policy = classifyValidationError(validation.error);
      const errorMessage = formatError(validation.error);
      const update: Parameters<typeof updateQueueEntryStatus>[1] =
        policy === 'hard'
          ? { status: 'failed', last_error: errorMessage, completed_at: now() }
          : { status: 'blocked', last_error: errorMessage };
      updateQueueEntryStatus(entry.id, update);
      const refreshed = getQueueEntry(entry.id);
      if (refreshed) this.events.emit('change', { entry: refreshed, promoted: false });
      return { ok: false, errorMessage };
    }

    const spawn = await performSpawn(validation.value, entry.user_id, supervisor);
    if (!spawn.ok) {
      const policy = classifyValidationError(spawn.error);
      const errorMessage = formatError(spawn.error);
      const update: Parameters<typeof updateQueueEntryStatus>[1] =
        policy === 'hard'
          ? { status: 'failed', last_error: errorMessage, completed_at: now() }
          : { status: 'blocked', last_error: errorMessage };
      updateQueueEntryStatus(entry.id, update);
      const refreshed = getQueueEntry(entry.id);
      if (refreshed) this.events.emit('change', { entry: refreshed, promoted: false });
      return { ok: false, errorMessage };
    }

    updateQueueEntryStatus(entry.id, {
      status: 'running',
      agent_id: spawn.agentId,
      started_at: now(),
      last_error: null
    });
    const refreshed = getQueueEntry(entry.id);
    if (refreshed) this.events.emit('change', { entry: refreshed, promoted: true });
    return { ok: true, agentId: spawn.agentId };
  }

  private parseOptionalArgs(json: string): Record<string, boolean> {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'boolean') out[k] = v;
        }
        return out;
      }
    } catch {
      // fall through
    }
    return {};
  }

  // -------------------------------------------------- termination listener

  private onAgentTerminated(agentId: string, terminalStatus: 'exited' | 'crashed'): void {
    const entry = getQueueEntryByAgentId(agentId);
    if (!entry) return;
    if (entry.status !== 'running') return; // already reconciled (cancel, etc.)
    const newStatus: QueueEntryStatus = terminalStatus === 'exited' ? 'done' : 'failed';
    const ts = now();
    updateQueueEntryStatus(entry.id, {
      status: newStatus,
      completed_at: ts,
      last_error: newStatus === 'failed' ? 'linked agent crashed' : null
    });
    const refreshed = getQueueEntry(entry.id);
    if (refreshed) this.events.emit('change', { entry: refreshed, promoted: false });
    this.scheduleTick();
  }
}

interface LiveAgent {
  agentId: string;
  repoId: string;
  /** True if the linked queue entry is exclusive or runs in repo root. */
  exclusiveLocked: boolean;
}

interface LiveAgentSet {
  byRepo: Map<string, LiveAgent[]>;
}

// --------- error classification ---------

/**
 * Permanent ("hard") failures move the entry to `failed`; transient
 * ("soft") failures keep it `blocked` so the next tick can retry. The
 * boundary is: anything the user has to fix is hard; anything that may
 * resolve itself (filesystem race, unrelated worktree path collision) is
 * soft and retried next tick.
 */
function classifyValidationError(err: SpawnError): 'hard' | 'soft' {
  switch (err.code) {
    case 'unknownRole':
    case 'unknownRepo':
    case 'unknownAdapter':
    case 'browserUrlEmpty':
    case 'browserUrlInvalid':
    case 'browserUrlScheme':
    case 'browserUrlHost':
    case 'browserUrlPort':
    case 'titleRequired':
    case 'titleUnslugifiable':
    case 'roleRepoRequired':
    case 'branchMissing':
      return 'hard';
    case 'titleTaken':
    case 'worktreeFailed':
    case 'spawnFailed':
      return 'soft';
    default: {
      // Exhaustiveness: TS will flag this if SpawnErrorCode grows. Treating
      // unknown codes as 'hard' is the safer default — surface to the user
      // rather than retry-forever.
      const _exhaustive: never = err.code;
      void _exhaustive;
      return 'hard';
    }
  }
}

function formatError(err: SpawnError): string {
  return err.message ? `${err.code}: ${err.message}` : err.code;
}

// --------- singleton accessor ---------

let singleton: QueueScheduler | null = null;

export function getQueueScheduler(): QueueScheduler {
  if (!singleton) singleton = new QueueScheduler();
  return singleton;
}

/** Test helper: tear down the singleton so a fresh one is created next time. */
export function resetQueueSchedulerForTests(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
