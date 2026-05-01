/**
 * AlertBus — process-wide fan-out of alert events from every live
 * AgentRuntime, scoped per user.
 *
 * The per-agent `runtime.on('alert', …)` listener is added by the hub
 * when a client subscribes to that specific agent's terminal panel. For
 * the dashboard's foreground toast, we want alerts from ANY agent the
 * user owns — even ones whose panel isn't currently open. This bus is
 * the bridge:
 *
 *   - AgentSupervisor wires every new AgentRuntime's `alert` event into
 *     the bus, tagging it with the runtime's `userId`.
 *   - Each HubClient (one per WS socket) subscribes once, on
 *     `subscribe_user_alerts`, and filters by its own user id before
 *     sending `SC_Alert` to the browser.
 *
 * Single-process scope by design — globalThis-backed so the
 * esbuild-bundled server.js and SvelteKit's chunk copy of this module
 * share one bus instance.
 */

import { EventEmitter } from 'node:events';
import type { AlertPayload } from './AgentRuntime.js';

export type UserAlertHandler = (userId: string, payload: AlertPayload) => void;

export class AlertBus extends EventEmitter {
  /**
   * Emit an alert from a runtime. Listeners registered via `onUserAlert`
   * receive `(userId, payload)`; the userId scope is applied by the
   * listener (the bus itself does not partition).
   */
  emitUserAlert(userId: string, payload: AlertPayload): void {
    this.emit('user-alert', userId, payload);
  }

  /** Register a listener for any user's alert. The handler MUST filter on
   *  `userId` before forwarding to a downstream client. Returns an
   *  unsubscribe function. */
  onUserAlert(handler: UserAlertHandler): () => void {
    this.on('user-alert', handler);
    return () => this.off('user-alert', handler);
  }
}

const G = globalThis as unknown as { __maw_alert_bus?: AlertBus };

export function getAlertBus(): AlertBus {
  if (!G.__maw_alert_bus) {
    G.__maw_alert_bus = new AlertBus();
    // Lift the listener cap above Node's default of 10 — one HubClient
    // per open tab adds a listener, and it's normal to have many tabs in
    // a multi-agent workbench. 1000 is generous; we'll see "MaxListeners"
    // warnings well before that if something leaks.
    G.__maw_alert_bus.setMaxListeners(1000);
  }
  return G.__maw_alert_bus;
}
