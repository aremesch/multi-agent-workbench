/**
 * Toast-store unit tests. The store is a plain svelte/store writable so
 * the tests run in jsdom without mounting a Svelte component.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  alertToasts,
  dismissToast,
  dismissToastsForAgent,
  pushToast
} from './alertToasts.js';
import type { SC_Alert } from '$lib/shared/protocol';

function clear(): void {
  for (const t of get(alertToasts)) {
    dismissToast(t.id);
  }
}

const alert = (over: Partial<SC_Alert> = {}): SC_Alert => ({
  type: 'alert',
  id: 'alert-1',
  agentId: 'agent-1',
  severity: 'warning',
  reason: 'x',
  body: 'y',
  url: '/repos/r1?agent=agent-1',
  ts: 1,
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  clear();
});
afterEach(() => {
  vi.useRealTimers();
  clear();
});

describe('pushToast', () => {
  it('appends a new toast', () => {
    pushToast(alert({ id: 'a1' }));
    expect(get(alertToasts).map((t) => t.id)).toEqual(['a1']);
  });

  it('replaces an existing toast with the same id (no duplicates)', () => {
    pushToast(alert({ id: 'a1', body: 'first' }));
    pushToast(alert({ id: 'a1', body: 'second' }));
    const arr = get(alertToasts);
    expect(arr).toHaveLength(1);
    expect(arr[0]?.body).toBe('second');
  });

  it('caps the visible stack at 5', () => {
    for (let i = 0; i < 8; i++) {
      pushToast(alert({ id: `a${i}`, severity: 'warning' }));
    }
    expect(get(alertToasts).length).toBe(5);
    // Oldest evicted, newest kept.
    expect(get(alertToasts)[0]?.id).toBe('a3');
    expect(get(alertToasts)[4]?.id).toBe('a7');
  });

  it('auto-dismisses info severities after the timer', () => {
    pushToast(alert({ id: 'a1', severity: 'info' }));
    expect(get(alertToasts)).toHaveLength(1);
    vi.advanceTimersByTime(20_000);
    expect(get(alertToasts)).toHaveLength(0);
  });

  it('does NOT auto-dismiss warning/error/critical', () => {
    pushToast(alert({ id: 'a1', severity: 'warning' }));
    pushToast(alert({ id: 'a2', severity: 'error' }));
    pushToast(alert({ id: 'a3', severity: 'critical' }));
    vi.advanceTimersByTime(60_000);
    expect(get(alertToasts).map((t) => t.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('falls back to /repos/<agent> when url is missing', () => {
    pushToast(alert({ id: 'a1', url: undefined }));
    expect(get(alertToasts)[0]?.url).toBe('/repos/agent-1');
  });

  it('ignores malformed alerts with no id', () => {
    pushToast({ ...alert(), id: '' });
    expect(get(alertToasts)).toHaveLength(0);
  });
});

describe('dismissToast', () => {
  it('removes the entry by id', () => {
    pushToast(alert({ id: 'a1' }));
    pushToast(alert({ id: 'a2' }));
    dismissToast('a1');
    expect(get(alertToasts).map((t) => t.id)).toEqual(['a2']);
  });

  it('cancels the auto-dismiss timer (no double-dismiss)', () => {
    pushToast(alert({ id: 'a1', severity: 'info' }));
    dismissToast('a1');
    expect(get(alertToasts)).toHaveLength(0);
    // Re-add same id; timer from the dismissed entry should not fire and
    // remove it again.
    pushToast(alert({ id: 'a1', severity: 'warning' }));
    vi.advanceTimersByTime(20_000);
    expect(get(alertToasts)).toHaveLength(1);
  });

  it('is a no-op for unknown ids', () => {
    pushToast(alert({ id: 'a1' }));
    dismissToast('nope');
    expect(get(alertToasts)).toHaveLength(1);
  });
});

describe('dismissToastsForAgent', () => {
  it('removes every toast belonging to that agent', () => {
    pushToast(alert({ id: 'a1', agentId: 'agent-A' }));
    pushToast(alert({ id: 'a2', agentId: 'agent-A' }));
    pushToast(alert({ id: 'a3', agentId: 'agent-B' }));
    dismissToastsForAgent('agent-A');
    expect(get(alertToasts).map((t) => t.id)).toEqual(['a3']);
  });
});
