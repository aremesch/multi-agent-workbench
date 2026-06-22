/**
 * AgentEventBus — process-wide fan-out of adapter events (`task_done`,
 * `prompt_detected`, `error`, …) from every live AgentRuntime, tagged with
 * the owning agent + user.
 *
 * Mirrors AlertBus, but for the SupervisorEngine rather than the dashboard
 * toast layer. The engine can't hold a direct reference to a runtime because
 * runtimes are private to AgentSupervisor and are recreated on reattach after
 * a reboot. Subscribing to this bus (wired once per runtime at spawn AND at
 * reattach, exactly like AlertBus) means the engine keeps observing its
 * agents' completion / question / error signals across restarts.
 *
 * Single-process, globalThis-backed so the esbuild-bundled server.js and
 * SvelteKit's chunk copy share one instance.
 */

import { EventEmitter } from 'node:events';
import type { AdapterEvent } from '../../shared/adapterTypes.js';

export interface AgentEventEnvelope {
  agentId: string;
  userId: string;
  event: AdapterEvent;
}

export type AgentEventHandler = (env: AgentEventEnvelope) => void;

export class AgentEventBus extends EventEmitter {
  emitAgentEvent(env: AgentEventEnvelope): void {
    this.emit('agent-event', env);
  }

  /** Register a listener for every agent's adapter events. The handler MUST
   *  filter on `agentId` / `userId`. Returns an unsubscribe function. */
  onAgentEvent(handler: AgentEventHandler): () => void {
    this.on('agent-event', handler);
    return () => this.off('agent-event', handler);
  }
}

const G = globalThis as unknown as { __maw_agent_event_bus?: AgentEventBus };

export function getAgentEventBus(): AgentEventBus {
  if (!G.__maw_agent_event_bus) {
    G.__maw_agent_event_bus = new AgentEventBus();
    G.__maw_agent_event_bus.setMaxListeners(1000);
  }
  return G.__maw_agent_event_bus;
}
