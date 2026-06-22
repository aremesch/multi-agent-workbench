/**
 * Production wiring for the SupervisorEngine: builds its impure collaborators
 * from the real singletons and subscribes it to the QueueScheduler + the
 * AgentEventBus. Kept out of bootstrap.ts to avoid import cycles and to keep
 * the engine itself free of singleton lookups (so it stays unit-testable).
 */

import { ulid } from 'ulid';
import type { AgentSupervisor } from '../agents/AgentSupervisor.js';
import type { QueueScheduler } from '../queue/Scheduler.js';
import type { PushService } from '../push/PushService.js';
import { getAgentEventBus } from '../agents/AgentEventBus.js';
import { WorktreeManager } from '../git/WorktreeManager.js';
import { insertAlert } from '../db/queries.js';
import { getAlertBus } from '../agents/AlertBus.js';
import { qcVerdict, splitPlan } from './llm.js';
import {
  getSupervisorEngine,
  type SupervisorEngine,
  type SupervisorEngineDeps,
  type SupervisorNotice
} from './SupervisorEngine.js';

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * Turn a SupervisorNotice into a persisted alert (when it's tied to an agent),
 * a dashboard toast (AlertBus), and a Web Push — reusing the exact channels
 * AgentRuntime.maybeAlert uses. Run-level notices with no agent (planning
 * failed, run complete) push-only, since the alerts table requires an agent.
 */
function makeNotifier(push: PushService): (n: SupervisorNotice) => void {
  return (n) => {
    const ts = now();
    const alertId = ulid();
    if (n.agentId) {
      insertAlert({
        id: alertId,
        user_id: n.userId,
        agent_id: n.agentId,
        severity: n.severity,
        reason: n.reason,
        payload_json: JSON.stringify({ body: n.body, source: 'supervisor', url: n.url }),
        ts
      });
      getAlertBus().emitUserAlert(n.userId, {
        id: alertId,
        agentId: n.agentId,
        severity: n.severity,
        agentTitle: 'Supervisor',
        reason: n.reason,
        body: n.body,
        url: n.url,
        ts
      });
    }
    push
      .notifyUser(n.userId, {
        title: 'Supervisor',
        body: n.body ? `${n.reason} — ${n.body}` : n.reason,
        data: {
          // SW uses agentId for the OS notification tag/grouping; fall back to
          // a stable literal for run-level (agent-less) notices.
          agentId: n.agentId ?? 'supervisor',
          alertId,
          url: n.url,
          severity: n.severity,
          agentTitle: 'Supervisor'
        }
      })
      .catch(() => {});
  };
}

export async function startSupervisorEngine(opts: {
  supervisor: AgentSupervisor;
  scheduler: QueueScheduler;
  push: PushService;
  apiKey: string;
}): Promise<SupervisorEngine> {
  const engine = getSupervisorEngine();
  const deps: SupervisorEngineDeps = {
    scheduleTick: () => opts.scheduler.scheduleTick(),
    cancelEntry: (entryId, userId) => opts.scheduler.cancelEntry(entryId, userId),
    getAgentInput: (agentId) => {
      const rt = opts.supervisor.get(agentId);
      if (!rt) return undefined;
      return { enqueueInput: (text, submit) => rt.enqueueInput(text, submit) };
    },
    splitPlanFn: splitPlan,
    qcVerdictFn: qcVerdict,
    verifyCommitFn: (wt, base) => WorktreeManager.verifyCommit(wt, base),
    pushBranchFn: (wt, branch) => WorktreeManager.pushBranch(wt, branch),
    diffSinceFn: (wt, base) => WorktreeManager.diffSince(wt, base),
    notify: makeNotifier(opts.push),
    apiKey: opts.apiKey
  };

  await engine.start(deps, (handlers) => {
    const offQueue = opts.scheduler.events.on('change', (e) => handlers.onQueueChange(e.entry.id));
    const offAgent = getAgentEventBus().onAgentEvent(({ agentId, event }) =>
      handlers.onAgentEvent(agentId, event)
    );
    return [offQueue, offAgent];
  });
  return engine;
}
