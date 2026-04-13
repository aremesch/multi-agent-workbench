/** User-setting key for push notification kind preferences. */
export const PUSH_PREFS_KEY = 'push.notify_kinds';

export type NotifyKind = 'prompt_detected' | 'task_done' | 'error' | 'exited';

export const ALL_NOTIFY_KINDS: NotifyKind[] = [
  'prompt_detected',
  'task_done',
  'error',
  'exited'
];

/** Default: all kinds enabled. */
export const DEFAULT_NOTIFY_KINDS: NotifyKind[] = [...ALL_NOTIFY_KINDS];

export function parseNotifyKinds(raw: string | null): NotifyKind[] {
  if (!raw) return DEFAULT_NOTIFY_KINDS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((k) => ALL_NOTIFY_KINDS.includes(k as NotifyKind)) as NotifyKind[];
  } catch { /* use default */ }
  return DEFAULT_NOTIFY_KINDS;
}
