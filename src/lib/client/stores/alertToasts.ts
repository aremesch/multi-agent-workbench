/**
 * Foreground alert toast store.
 *
 * One module-level store holds the currently visible toasts. The
 * `<AlertToastContainer>` mounted in the root layout subscribes once
 * (via `getMawWsClient().subscribeUserAlerts`) and pushes incoming
 * `SC_Alert` messages here; the container renders the resulting array
 * top-right with a stack animation.
 *
 * Dedup: keyed on `alertId`. If the same alert id arrives twice (e.g.
 * the user has both `subscribe_user_alerts` AND a per-agent
 * `subscribe_agent` open), the second push is silently dropped — the
 * toast is replaced in-place rather than stacking.
 *
 * Auto-dismiss: only `info` severities tear down on a timer. `warning`,
 * `error`, and `critical` stay until the user clicks Open or X — they
 * represent something the human needs to act on.
 */

import { writable, get, type Readable } from 'svelte/store';
import type { SC_Alert } from '$lib/shared/protocol';

export interface ToastEntry {
  id: string;
  agentId: string;
  reason: string;
  body: string;
  url: string;
  severity: SC_Alert['severity'];
  ts: number;
}

const INFO_AUTO_DISMISS_MS = 12_000;
const MAX_VISIBLE = 5;

const toasts = writable<ToastEntry[]>([]);

/** Read-only handle for the container component. */
export const alertToasts: Readable<ToastEntry[]> = toasts;

const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Push a fresh alert into the toast stack. Existing entries with the
 * same `id` are replaced in place (preserving stack order). The oldest
 * toast is evicted once `MAX_VISIBLE` is exceeded.
 */
export function pushToast(alert: SC_Alert): void {
  if (!alert.id) return;
  const entry: ToastEntry = {
    id: alert.id,
    agentId: alert.agentId,
    reason: alert.reason,
    body: alert.body ?? '',
    url: alert.url ?? `/repos/${alert.agentId}`,
    severity: alert.severity,
    ts: alert.ts
  };

  toasts.update((arr) => {
    const idx = arr.findIndex((t) => t.id === entry.id);
    if (idx >= 0) {
      const next = arr.slice();
      next[idx] = entry;
      return next;
    }
    const next = [...arr, entry];
    while (next.length > MAX_VISIBLE) next.shift();
    return next;
  });

  if (entry.severity === 'info') {
    scheduleAutoDismiss(entry.id);
  }
}

/** Remove a toast by id. No-op if it's already gone. */
export function dismissToast(id: string): void {
  const t = dismissTimers.get(id);
  if (t) {
    clearTimeout(t);
    dismissTimers.delete(id);
  }
  toasts.update((arr) => arr.filter((entry) => entry.id !== id));
}

/** Remove every toast for the given agent — used by the auto-ack flow
 *  when the user opens the agent's terminal modal. */
export function dismissToastsForAgent(agentId: string): void {
  const current = get(toasts);
  for (const entry of current) {
    if (entry.agentId === agentId) {
      dismissToast(entry.id);
    }
  }
}

function scheduleAutoDismiss(id: string): void {
  const existing = dismissTimers.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    dismissTimers.delete(id);
    dismissToast(id);
  }, INFO_AUTO_DISMISS_MS);
  dismissTimers.set(id, timer);
}
