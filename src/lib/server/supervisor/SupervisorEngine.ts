/**
 * SupervisorEngine — process-wide singleton that drives a product plan
 * end-to-end. Deterministic state machine (like QueueScheduler); the only LLM
 * calls are plan-splitting and the QC verdict (see ./llm.ts).
 *
 * It is a CONSUMER of the existing machinery: it inserts queue_entries and
 * reacts to (a) the QueueScheduler's 'change' events (promotion → link agent;
 * crash → handle failure) and (b) the AgentEventBus (`task_done` → work
 * finished; `prompt_detected`/`error` → block on human). It never spawns or
 * kills agents directly — promotion is the scheduler's job, killing goes
 * through scheduler.cancelEntry (which kills the linked agent).
 *
 * Run phases:   planning → awaiting_approval → executing → (stopping) →
 *               done | stopped | failed
 * Step phases:  pending → running_task → awaiting_commit → quality_check
 *                 → fixing ↺ running_task          (QC fail, under cap)
 *                 → ready_to_push → pushed → done   (QC pass)
 *               blocked_on_human is orthogonal (watchdog / cap / crash).
 *
 * Every transition writes the DB phase + a supervisor_run_events checkpoint
 * BEFORE side effects, so a reboot resumes from the persisted position
 * (see init()).
 */

import { EventEmitter } from 'node:events';
import { ulid } from 'ulid';
import {
  getAgent,
  getQueueEntry,
  getQueueEntryByAgentId,
  getRepo,
  getRole,
  getSupervisorRun,
  getSupervisorStep,
  getSupervisorStepByQueueEntry,
  getWorktree,
  insertLlmOversightVerdict,
  insertQueueEntry,
  insertSupervisorRunEvent,
  insertSupervisorStep,
  listActiveSupervisorRuns,
  listSupervisorSteps,
  sumVerdictTokensForRun,
  updateSupervisorRun,
  updateSupervisorStep,
  type SupervisorSettings
} from '../db/queries.js';
import type {
  SupervisorRunRow,
  SupervisorStepPhase,
  SupervisorStepRow,
  SupervisorStopMode
} from '../db/types.js';
import type { AdapterEvent } from '../../shared/adapterTypes.js';
import { qcVerdict, splitPlan, type QcIssue } from './llm.js';
import { recordVerdictIssues, renderLessons } from './projectMemory.js';

const now = (): number => Math.floor(Date.now() / 1000);

/** Step phases where work is in flight — the engine waits for an event. */
const ACTIVE_STEP_PHASES: ReadonlySet<SupervisorStepPhase> = new Set([
  'running_task',
  'awaiting_commit',
  'quality_check',
  'fixing',
  'ready_to_push'
]);

export interface SupervisorNotice {
  userId: string;
  agentId: string | null;
  severity: 'info' | 'warning' | 'error' | 'critical';
  reason: string;
  body: string;
  url: string;
}

/** Impure collaborators — injected so the state machine is unit-testable. */
export interface SupervisorEngineDeps {
  scheduleTick: () => void;
  cancelEntry: (entryId: string, userId: string) => Promise<boolean>;
  /** Returns an input handle for a LIVE agent, or undefined if it's gone. */
  getAgentInput: (
    agentId: string
  ) => { enqueueInput: (text: string, submit: boolean) => Promise<void> } | undefined;
  splitPlanFn: typeof splitPlan;
  qcVerdictFn: typeof qcVerdict;
  verifyCommitFn: (
    wtPath: string,
    baseSha: string | null
  ) => Promise<{ committed: boolean; head: string | null; dirty: boolean }>;
  pushBranchFn: (wtPath: string, branch: string) => Promise<void>;
  diffSinceFn: (wtPath: string, baseSha: string | null) => Promise<string>;
  notify: (notice: SupervisorNotice) => void;
  apiKey: string;
}

export interface RunChangeEvent {
  runId: string;
  userId: string;
}

export class SupervisorEngineEvents {
  private readonly inner = new EventEmitter();
  on(event: 'change', listener: (e: RunChangeEvent) => void): () => void {
    this.inner.on(event, listener as (...a: unknown[]) => void);
    return () => this.inner.off(event, listener as (...a: unknown[]) => void);
  }
  emit(event: 'change', payload: RunChangeEvent): void {
    this.inner.emit(event, payload);
  }
  removeAllListeners(): void {
    this.inner.removeAllListeners();
  }
}

export function permissionModeFor(autonomy: SupervisorSettings['autonomy']): string | null {
  switch (autonomy) {
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'auto_safe':
      return 'acceptEdits';
    case 'defer_all':
      return null; // adapter default
  }
}

export class SupervisorEngine {
  readonly events = new SupervisorEngineEvents();
  private deps: SupervisorEngineDeps | null = null;
  private unsubs: Array<() => void> = [];
  private stallTimers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  /**
   * Wire up event sources and reconcile any in-flight runs left over from a
   * previous process. `subscribe` registers (and returns disposers for) the
   * scheduler + agent-event listeners; bootstrap supplies these so the engine
   * doesn't import the scheduler/supervisor singletons directly (avoids cycles
   * and keeps tests free of them).
   */
  async start(
    deps: SupervisorEngineDeps,
    subscribe: (handlers: {
      onQueueChange: (entryId: string) => void;
      onAgentEvent: (agentId: string, event: AdapterEvent) => void;
    }) => Array<() => void>
  ): Promise<void> {
    if (this.deps) throw new Error('SupervisorEngine.start: already started');
    this.deps = deps;
    this.stopped = false;
    this.unsubs = subscribe({
      onQueueChange: (entryId) => this.onQueueChange(entryId),
      onAgentEvent: (agentId, event) => this.onAgentEvent(agentId, event)
    });
    await this.reconcile();
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const t of this.stallTimers.values()) clearTimeout(t);
    this.stallTimers.clear();
    this.deps = null;
  }

  private dep(): SupervisorEngineDeps {
    if (!this.deps) throw new Error('SupervisorEngine not started');
    return this.deps;
  }

  private cfg(run: SupervisorRunRow): SupervisorSettings {
    try {
      return JSON.parse(run.config_json) as SupervisorSettings;
    } catch {
      // Should never happen — config_json is frozen at create time — but fall
      // back to conservative defaults rather than throwing mid-run.
      return {
        plannerPrompt: '',
        fixLoopCap: 3,
        executionMode: 'sequential',
        autonomy: 'bypassPermissions',
        model: 'claude-opus-4-8',
        tokenBudget: 0,
        stallTimeoutSec: 1800
      };
    }
  }

  // -------------------------------------------------- checkpointing

  private checkpoint(runId: string, stepId: string | null, kind: string, payload: unknown = {}): void {
    insertSupervisorRunEvent({
      id: ulid(),
      run_id: runId,
      step_id: stepId,
      kind,
      payload_json: JSON.stringify(payload)
    });
  }

  private emitChange(run: { id: string; user_id: string }): void {
    this.events.emit('change', { runId: run.id, userId: run.user_id });
  }

  // -------------------------------------------------- planning

  /**
   * Split a run's plan into steps via the planner LLM call. Idempotent-ish:
   * only acts when the run is in `planning`. On success → awaiting_approval.
   */
  async startPlanning(runId: string): Promise<void> {
    const run = getSupervisorRun(runId);
    if (!run || run.phase !== 'planning') return;
    const cfg = this.cfg(run);
    const d = this.dep();
    try {
      const { result, usage } = await d.splitPlanFn({
        apiKey: d.apiKey,
        model: cfg.model,
        systemPrompt: cfg.plannerPrompt,
        planMd: run.plan_md,
        lessons: renderLessons(run.repo_id)
      });
      result.tasks.forEach((task, idx) => {
        const stepId = ulid();
        // depends_on holds 0-based indices of earlier tasks; map to step ids
        // once all are inserted. We mint ids first so we can resolve them.
        insertSupervisorStep({
          id: stepId,
          run_id: runId,
          user_id: run.user_id,
          seq: idx,
          title: task.title,
          body: task.body,
          depends_on_json: JSON.stringify(task.depends_on ?? []),
          phase: 'pending'
        });
      });
      // Second pass: rewrite index-based deps to step-id-based deps.
      const steps = listSupervisorSteps(runId);
      for (const step of steps) {
        const idxDeps = JSON.parse(step.depends_on_json) as number[];
        const idDeps = idxDeps
          .map((i) => steps[i]?.id)
          .filter((x): x is string => typeof x === 'string' && x !== step.id);
        updateSupervisorStep(step.id, { depends_on_json: JSON.stringify(idDeps) });
      }
      updateSupervisorRun(runId, { phase: 'awaiting_approval' });
      this.checkpoint(runId, null, 'planned', { tasks: result.tasks.length, usage });
      this.emitChange(run);
    } catch (err) {
      updateSupervisorRun(runId, { phase: 'failed', error: `planning failed: ${(err as Error).message}` });
      this.checkpoint(runId, null, 'planning_failed', { error: (err as Error).message });
      d.notify({
        userId: run.user_id,
        agentId: null,
        severity: 'error',
        reason: 'Supervisor planning failed',
        body: (err as Error).message.slice(0, 200),
        url: `/supervisor/${runId}`
      });
      this.emitChange(run);
    }
  }

  /**
   * Re-split a single step from the human's requested changes. Replaces the
   * step in place (1 task) or fans it into multiple tasks if the planner
   * decides it should be split further. Only valid while awaiting_approval.
   */
  async refineStep(stepId: string): Promise<void> {
    const step = getSupervisorStep(stepId);
    if (!step || step.approval_state !== 'sent_back') return;
    const run = getSupervisorRun(step.run_id);
    if (!run || run.phase !== 'awaiting_approval') return;
    const cfg = this.cfg(run);
    const d = this.dep();
    const planMd =
      `Refine this single task based on the requested changes. Return one or more ` +
      `tasks that replace it.\n\nTask: ${step.title}\n${step.body}\n\n` +
      `Requested changes:\n${step.refinement_notes ?? ''}`;
    const { result } = await d.splitPlanFn({
      apiKey: d.apiKey,
      model: cfg.model,
      systemPrompt: cfg.plannerPrompt,
      planMd,
      lessons: renderLessons(run.repo_id)
    });
    const first = result.tasks[0];
    if (!first) return;
    // Reuse the existing row for the first task; insert any extras after it.
    updateSupervisorStep(step.id, {
      title: first.title,
      body: first.body,
      approval_state: 'pending',
      refinement_notes: null
    });
    for (let i = 1; i < result.tasks.length; i++) {
      const t = result.tasks[i]!;
      insertSupervisorStep({
        id: ulid(),
        run_id: run.id,
        user_id: run.user_id,
        seq: step.seq + i, // place extras right after the refined step
        title: t.title,
        body: t.body,
        depends_on_json: '[]',
        phase: 'pending'
      });
    }
    this.checkpoint(run.id, step.id, 'step_refined', { tasks: result.tasks.length });
    this.emitChange(run);
  }

  // -------------------------------------------------- approval + run control

  /** Start execution once the human has approved (some of) the steps. */
  approveRun(runId: string): void {
    const run = getSupervisorRun(runId);
    if (!run || run.phase !== 'awaiting_approval') return;
    updateSupervisorRun(runId, { phase: 'executing', started_at: run.started_at ?? now() });
    this.checkpoint(runId, null, 'approved');
    this.emitChange(run);
    void this.advance(runId);
  }

  async requestStop(runId: string, mode: SupervisorStopMode): Promise<void> {
    const run = getSupervisorRun(runId);
    if (!run) return;
    if (run.phase === 'done' || run.phase === 'stopped' || run.phase === 'failed') return;
    const d = this.dep();
    if (mode === 'emergency') {
      updateSupervisorRun(runId, { stop_mode: 'emergency', phase: 'stopping' });
      this.checkpoint(runId, null, 'emergency_stop_requested');
      const steps = listSupervisorSteps(runId);
      for (const step of steps) {
        for (const entryId of [step.queue_entry_id, step.qc_queue_entry_id]) {
          if (entryId) await d.cancelEntry(entryId, run.user_id).catch(() => {});
        }
        this.clearStall(step.id);
        if (!['done', 'failed'].includes(step.phase)) {
          updateSupervisorStep(step.id, { phase: 'failed', blocked_reason: 'emergency stop' });
        }
      }
      this.finishRun(runId, 'stopped');
      return;
    }
    // normal: stop enqueuing new steps; let in-flight finish.
    updateSupervisorRun(runId, { stop_mode: 'normal', phase: 'stopping' });
    this.checkpoint(runId, null, 'normal_stop_requested');
    this.emitChange(run);
    void this.advance(runId);
  }

  private finishRun(runId: string, phase: 'done' | 'stopped'): void {
    const run = getSupervisorRun(runId);
    if (!run) return;
    updateSupervisorRun(runId, { phase, completed_at: now(), current_step_id: null });
    this.checkpoint(runId, null, phase === 'done' ? 'run_done' : 'run_stopped');
    this.dep().notify({
      userId: run.user_id,
      agentId: null,
      severity: 'info',
      reason: phase === 'done' ? 'Supervisor run complete' : 'Supervisor run stopped',
      body: run.title,
      url: `/supervisor/${runId}`
    });
    this.emitChange(run);
  }

  // -------------------------------------------------- the driver

  /**
   * Pick the next thing to do for a run. Event-driven: called after approval,
   * after each step transition, and after a relevant scheduler/agent event.
   * Sequential mode: at most one step in flight; a blocked step halts the run
   * until the human resolves it.
   */
  async advance(runId: string): Promise<void> {
    if (this.stopped) return;
    const run = getSupervisorRun(runId);
    if (!run) return;
    if (run.phase !== 'executing' && run.phase !== 'stopping') return;
    if (run.stop_mode === 'emergency') return;

    const steps = listSupervisorSteps(runId);
    const active = steps.find((s) => ACTIVE_STEP_PHASES.has(s.phase));
    if (active) return; // wait for its events
    const blocked = steps.find((s) => s.phase === 'blocked_on_human');
    if (blocked) return; // sequential: don't start new work while one is blocked

    if (run.stop_mode === 'normal') {
      this.finishRun(runId, 'stopped');
      return;
    }

    const doneIds = new Set(steps.filter((s) => s.phase === 'done').map((s) => s.id));
    const next = steps.find(
      (s) =>
        s.phase === 'pending' &&
        s.approval_state === 'approved' &&
        (JSON.parse(s.depends_on_json) as string[]).every((d) => doneIds.has(d))
    );
    if (!next) {
      const remaining = steps.filter(
        (s) => s.approval_state === 'approved' && s.phase !== 'done' && s.phase !== 'failed'
      );
      if (remaining.length === 0) this.finishRun(runId, 'done');
      return;
    }
    await this.startStepTask(run, next);
  }

  private composeBody(run: SupervisorRunRow, body: string, extra: string): string {
    const lessons = renderLessons(run.repo_id);
    const lessonBlock = lessons.length
      ? `\n\nKnown recurring issues in this repo — avoid these:\n` + lessons.map((l) => `- ${l}`).join('\n')
      : '';
    return `${body}${extra}${lessonBlock}`;
  }

  private enqueue(opts: {
    run: SupervisorRunRow;
    step: SupervisorStepRow;
    kind: 'task' | 'qc' | 'fix';
    roleId: string;
    title: string;
    body: string;
    sourceBranch: string | null;
  }): string {
    const cfg = this.cfg(opts.run);
    const entryId = ulid();
    insertQueueEntry({
      id: entryId,
      user_id: opts.run.user_id,
      role_id: opts.roleId,
      repo_id: opts.run.repo_id,
      title: opts.title,
      body: opts.body,
      target_url: null,
      model: null,
      permission_mode: permissionModeFor(cfg.autonomy),
      source_branch: opts.sourceBranch,
      with_worktree: true,
      optional_args_json: '{}',
      priority: 50,
      depends_on_json: '[]',
      scheduled_for: null,
      exclusive: false,
      queued: true,
      plan_md: null,
      plan_source_path: null,
      status: 'pending',
      external_source_json: JSON.stringify({
        supervisor_run_id: opts.run.id,
        step_id: opts.step.id,
        kind: opts.kind
      })
    });
    this.dep().scheduleTick();
    return entryId;
  }

  private async startStepTask(run: SupervisorRunRow, step: SupervisorStepRow): Promise<void> {
    const repo = getRepo(run.repo_id);
    const body = this.composeBody(
      run,
      step.body,
      `\n\nWhen the task is complete, commit ALL your work to git with a clear, conventional commit message. Do not push — the supervisor handles that.`
    );
    const entryId = this.enqueue({
      run,
      step,
      kind: 'task',
      roleId: run.role_id,
      title: step.title,
      body,
      sourceBranch: repo?.default_branch ?? null
    });
    updateSupervisorStep(step.id, { phase: 'running_task', queue_entry_id: entryId });
    updateSupervisorRun(run.id, { current_step_id: step.id });
    this.checkpoint(run.id, step.id, 'step_started');
    this.armStall(run, step.id);
    this.emitChange(run);
  }

  // -------------------------------------------------- event reactions

  private onQueueChange(entryId: string): void {
    if (this.stopped) return;
    const step = getSupervisorStepByQueueEntry(entryId);
    if (!step) return; // not a supervisor entry
    const qEntry = getQueueEntry(entryId);
    if (!qEntry) return;

    if (qEntry.status === 'running' && qEntry.agent_id) {
      // Promotion: link the agent (+ branch/base for the coding entry).
      if (step.queue_entry_id === entryId) {
        const agent = getAgent(qEntry.agent_id);
        const wt = agent?.worktree_id ? getWorktree(agent.worktree_id) : undefined;
        const patch: Parameters<typeof updateSupervisorStep>[1] = { agent_id: qEntry.agent_id };
        // Only set base_sha on the FIRST promotion so fixes still diff from the
        // original base (we want QC to review the whole step each round).
        if (!step.base_sha) patch.base_sha = agent?.base_sha ?? null;
        if (!step.branch) patch.branch = wt?.branch ?? null;
        updateSupervisorStep(step.id, patch);
      }
      return;
    }
    if (qEntry.status === 'failed') {
      void this.handleFailure(step.id, 'agent crashed');
    }
    // 'done' (agent exited) is handled via the task_done event path / onAgentEvent;
    // 'cancelled' is the engine's own teardown — ignore.
  }

  private onAgentEvent(agentId: string, event: AdapterEvent): void {
    if (this.stopped) return;
    const entry = getQueueEntryByAgentId(agentId);
    if (!entry) return;
    const step = getSupervisorStepByQueueEntry(entry.id);
    if (!step) return;
    const run = getSupervisorRun(step.run_id);
    if (!run) return;
    const isCoding = step.queue_entry_id === entry.id;
    const isQc = step.qc_queue_entry_id === entry.id;

    if (event.kind === 'error') {
      void this.blockOnHuman(step.id, agentId, `agent error: ${event.patternId ?? 'unknown'}`);
      return;
    }
    if (event.kind === 'prompt_detected') {
      // In full-auto there are no permission prompts, but the agent can still
      // pause to ask a genuine question (elicitation/idle). Defer to the human.
      void this.blockOnHuman(step.id, agentId, 'agent is asking a question');
      return;
    }
    if (event.kind !== 'task_done') return;

    if (isCoding && (step.phase === 'running_task' || step.phase === 'awaiting_commit' || step.phase === 'fixing')) {
      void this.onCodingFinished(run, step, agentId);
    } else if (isQc && step.phase === 'quality_check') {
      void this.onQcFinished(run, step, agentId);
    }
  }

  // -------------------------------------------------- coding → commit → QC

  private worktreePathFor(agentId: string | null): string | null {
    if (!agentId) return null;
    const agent = getAgent(agentId);
    if (!agent?.worktree_id) return null;
    return getWorktree(agent.worktree_id)?.path ?? null;
  }

  private async onCodingFinished(
    run: SupervisorRunRow,
    step: SupervisorStepRow,
    agentId: string
  ): Promise<void> {
    this.clearStall(step.id);
    const wt = this.worktreePathFor(step.agent_id ?? agentId);
    if (!wt) {
      await this.blockOnHuman(step.id, agentId, 'worktree not found for commit check');
      return;
    }
    const d = this.dep();
    const { committed, dirty } = await d.verifyCommitFn(wt, step.base_sha);
    if (committed && !dirty) {
      await this.startQc(run, step);
      return;
    }
    // Not committed (or leftover changes). Ask the live agent to commit once.
    const input = d.getAgentInput(agentId);
    if (step.phase !== 'awaiting_commit' && input) {
      await input
        .enqueueInput('Please commit ALL your changes to git now with a clear message. Do not push.', true)
        .catch(() => {});
      updateSupervisorStep(step.id, { phase: 'awaiting_commit' });
      this.checkpoint(run.id, step.id, 'commit_requested');
      this.armStall(run, step.id);
      this.emitChange(run);
      return;
    }
    await this.blockOnHuman(step.id, agentId, 'agent finished but did not commit its work');
  }

  private async startQc(run: SupervisorRunRow, step: SupervisorStepRow): Promise<void> {
    const body = this.composeBody(
      run,
      `Review the code changes on this branch (run \`git diff ${step.base_sha ?? 'HEAD~'}..HEAD\`) for the task below. ` +
        `Check for correctness, DRY violations, dead code, naming, tight coupling, missing tests, error handling, and security. ` +
        `Report every issue you find.\n\nTask: ${step.title}\n${step.body}`,
      ''
    );
    const entryId = this.enqueue({
      run,
      step,
      kind: 'qc',
      roleId: run.qc_role_id,
      title: `QC: ${step.title}`,
      body,
      sourceBranch: step.branch
    });
    updateSupervisorStep(step.id, { phase: 'quality_check', qc_queue_entry_id: entryId });
    this.checkpoint(run.id, step.id, 'qc_started');
    this.armStall(run, step.id);
    this.emitChange(run);
  }

  // -------------------------------------------------- QC → verdict → branch

  private async onQcFinished(
    run: SupervisorRunRow,
    step: SupervisorStepRow,
    qcAgentId: string
  ): Promise<void> {
    this.clearStall(step.id);
    const cfg = this.cfg(run);
    const d = this.dep();

    // Token budget guard.
    if (cfg.tokenBudget > 0 && sumVerdictTokensForRun(run.id) >= cfg.tokenBudget) {
      await this.blockOnHuman(step.id, qcAgentId, 'token budget exhausted');
      return;
    }

    const codingWt = this.worktreePathFor(step.agent_id);
    const diff = codingWt ? await d.diffSinceFn(codingWt, step.base_sha) : '';
    const qcRole = getRole(run.qc_role_id);

    let verdict: { verdict: 'pass' | 'fail'; summary: string; issues: QcIssue[] };
    let usage = { tokensIn: 0, tokensOut: 0 };
    try {
      const res = await d.qcVerdictFn({
        apiKey: d.apiKey,
        model: cfg.model,
        systemPrompt: qcRole?.system_prompt ?? '',
        taskTitle: step.title,
        taskBody: step.body,
        diff,
        lessons: renderLessons(run.repo_id)
      });
      verdict = res.result;
      usage = res.usage;
    } catch (err) {
      await this.blockOnHuman(step.id, qcAgentId, `QC verdict failed: ${(err as Error).message}`);
      return;
    }

    const verdictId = ulid();
    insertLlmOversightVerdict({
      id: verdictId,
      user_id: run.user_id,
      agent_id: qcAgentId,
      verdict: verdict.verdict,
      rationale: JSON.stringify({ summary: verdict.summary, issues: verdict.issues }),
      model: cfg.model,
      tokens_in: usage.tokensIn,
      tokens_out: usage.tokensOut
    });
    updateSupervisorStep(step.id, { last_verdict_id: verdictId });
    recordVerdictIssues({ userId: run.user_id, repoId: run.repo_id, runId: run.id, issues: verdict.issues });
    this.checkpoint(run.id, step.id, 'qc_verdict', { verdict: verdict.verdict, issues: verdict.issues.length });

    // QC agent's work is done — free its slot + kill it.
    if (step.qc_queue_entry_id) {
      await d.cancelEntry(step.qc_queue_entry_id, run.user_id).catch(() => {});
      updateSupervisorStep(step.id, { qc_queue_entry_id: null });
    }

    if (verdict.verdict === 'pass') {
      await this.pushStep(run, step);
    } else if (step.fix_iterations < cfg.fixLoopCap) {
      await this.startFix(run, step, verdict.issues);
    } else {
      await this.blockOnHuman(
        step.id,
        step.agent_id ?? qcAgentId,
        `QC still failing after ${cfg.fixLoopCap} fix attempts`
      );
    }
  }

  private async startFix(run: SupervisorRunRow, step: SupervisorStepRow, issues: QcIssue[]): Promise<void> {
    const fixIter = step.fix_iterations + 1;
    const issueText = issues.map((i) => `- [${i.severity}] ${i.category}: ${i.detail}`).join('\n');
    const body = this.composeBody(
      run,
      `Quality check found issues with your previous work. Fix ALL of them, then commit (do not push):\n\n${issueText}`,
      ''
    );
    const d = this.dep();
    const input = step.agent_id ? d.getAgentInput(step.agent_id) : undefined;
    if (input) {
      // Reuse the live coding agent + its worktree/branch.
      await input.enqueueInput(body, true).catch(() => {});
      updateSupervisorStep(step.id, { phase: 'fixing', fix_iterations: fixIter });
    } else {
      // Coding agent gone — spawn a fresh fix agent on the step's branch.
      const entryId = this.enqueue({
        run,
        step,
        kind: 'fix',
        roleId: run.role_id,
        title: `Fix: ${step.title}`,
        body,
        sourceBranch: step.branch
      });
      updateSupervisorStep(step.id, { phase: 'fixing', fix_iterations: fixIter, queue_entry_id: entryId });
    }
    this.checkpoint(run.id, step.id, 'fix_started', { iteration: fixIter });
    this.armStall(run, step.id);
    this.emitChange(run);
  }

  private async pushStep(run: SupervisorRunRow, step: SupervisorStepRow): Promise<void> {
    updateSupervisorStep(step.id, { phase: 'ready_to_push' });
    const wt = this.worktreePathFor(step.agent_id);
    const d = this.dep();
    if (!wt || !step.branch) {
      await this.blockOnHuman(step.id, step.agent_id, 'cannot locate branch/worktree to push');
      return;
    }
    try {
      await d.pushBranchFn(wt, step.branch);
    } catch (err) {
      await this.blockOnHuman(step.id, step.agent_id, `git push failed: ${(err as Error).message}`);
      return;
    }
    // Done — kill the (idle) coding agent to free the slot.
    if (step.queue_entry_id) await d.cancelEntry(step.queue_entry_id, run.user_id).catch(() => {});
    updateSupervisorStep(step.id, { phase: 'pushed' });
    updateSupervisorStep(step.id, { phase: 'done' });
    this.checkpoint(run.id, step.id, 'step_pushed', { branch: step.branch });
    d.notify({
      userId: run.user_id,
      agentId: step.agent_id,
      severity: 'info',
      reason: `Step ready for PR: ${step.title}`,
      body: `Branch ${step.branch} pushed — open a PR into your development branch.`,
      url: `/supervisor/${run.id}`
    });
    this.emitChange(run);
    await this.advance(run.id);
  }

  // -------------------------------------------------- block / failure

  private async blockOnHuman(stepId: string, agentId: string | null, reason: string): Promise<void> {
    this.clearStall(stepId);
    const step = getSupervisorStep(stepId);
    if (!step) return;
    const run = getSupervisorRun(step.run_id);
    if (!run) return;
    updateSupervisorStep(stepId, { phase: 'blocked_on_human', blocked_reason: reason });
    this.checkpoint(run.id, stepId, 'blocked_on_human', { reason });
    this.dep().notify({
      userId: run.user_id,
      agentId,
      severity: 'warning',
      reason: `Supervisor needs you: ${step.title}`,
      body: reason,
      url: `/supervisor/${run.id}`
    });
    this.emitChange(run);
  }

  private async handleFailure(stepId: string, reason: string): Promise<void> {
    // One crash → block on human (the human can resume or stop the run).
    await this.blockOnHuman(stepId, null, reason);
  }

  /**
   * Human resolved a blocked step. `resume` retries the step from scratch;
   * `skip` marks it done and moves on. Called from the API.
   */
  async resolveBlock(stepId: string, action: 'resume' | 'skip'): Promise<void> {
    const step = getSupervisorStep(stepId);
    if (!step || step.phase !== 'blocked_on_human') return;
    const run = getSupervisorRun(step.run_id);
    if (!run) return;
    if (action === 'skip') {
      updateSupervisorStep(stepId, { phase: 'done', blocked_reason: null });
      this.checkpoint(run.id, stepId, 'block_skipped');
    } else {
      updateSupervisorStep(stepId, { phase: 'pending', blocked_reason: null, queue_entry_id: null, qc_queue_entry_id: null, agent_id: null, base_sha: null, branch: null });
      this.checkpoint(run.id, stepId, 'block_resumed');
    }
    this.emitChange(run);
    await this.advance(run.id);
  }

  // -------------------------------------------------- stall watchdog

  private armStall(run: SupervisorRunRow, stepId: string): void {
    this.clearStall(stepId);
    const cfg = this.cfg(run);
    if (cfg.stallTimeoutSec <= 0) return;
    const t = setTimeout(() => {
      this.stallTimers.delete(stepId);
      const step = getSupervisorStep(stepId);
      if (step && ACTIVE_STEP_PHASES.has(step.phase)) {
        void this.blockOnHuman(stepId, step.agent_id, `no activity for ${cfg.stallTimeoutSec}s`);
      }
    }, cfg.stallTimeoutSec * 1000);
    t.unref?.();
    this.stallTimers.set(stepId, t);
  }

  private clearStall(stepId: string): void {
    const t = this.stallTimers.get(stepId);
    if (t) {
      clearTimeout(t);
      this.stallTimers.delete(stepId);
    }
  }

  // -------------------------------------------------- reboot reconciliation

  /**
   * Resume in-flight runs after a process restart. Honors stop_mode first,
   * then nudges each executing run forward. Steps in an active phase are
   * re-armed for stall detection; their underlying agents are reattached by
   * AgentSupervisor.init() and the queue entries are reconciled by the
   * QueueScheduler before us, so we mostly re-derive position and continue.
   */
  async reconcile(): Promise<void> {
    for (const run of listActiveSupervisorRuns()) {
      if (run.stop_mode === 'emergency') {
        await this.requestStop(run.id, 'emergency').catch(() => {});
        continue;
      }
      if (run.phase === 'planning') {
        // Planning was interrupted by the restart. Re-running the planner here
        // would fork a second LLM call and risk duplicate steps, so we leave
        // the run as-is; the UI offers a "retry planning" action (re-invokes
        // startPlanning) which is safe because that path no-ops unless the run
        // is still in `planning`.
        continue;
      }
      if (run.phase === 'executing' || run.phase === 'stopping') {
        for (const step of listSupervisorSteps(run.id)) {
          if (ACTIVE_STEP_PHASES.has(step.phase)) this.armStall(run, step.id);
        }
        await this.advance(run.id).catch(() => {});
      }
    }
  }
}

// --------- singleton ---------

let singleton: SupervisorEngine | null = null;

export function getSupervisorEngine(): SupervisorEngine {
  if (!singleton) singleton = new SupervisorEngine();
  return singleton;
}

export function resetSupervisorEngineForTests(): void {
  if (singleton) singleton.stop();
  singleton = null;
}
