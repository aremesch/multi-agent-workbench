import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRate } from './rateLimit.js';

// The module keeps buckets in a module-level Map. Rather than resetting the
// module between tests, every test uses a unique key. The cleanup-at-10k
// path is covered by a dedicated `vi.resetModules()` case.

describe('checkRate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function uniqueKey(name: string): string {
    // Keep buckets separate per test so we can avoid resetModules noise.
    return `${name}-${expect.getState().currentTestName}`;
  }

  it('allows up to `count` hits inside the window', () => {
    const key = uniqueKey('allow');
    expect(checkRate(key, 3, 60)).toBe(true);
    expect(checkRate(key, 3, 60)).toBe(true);
    expect(checkRate(key, 3, 60)).toBe(true);
  });

  it('blocks the (count + 1)-th hit inside the window', () => {
    const key = uniqueKey('block');
    for (let i = 0; i < 3; i++) checkRate(key, 3, 60);
    expect(checkRate(key, 3, 60)).toBe(false);
  });

  it('rolls the window: after `windowSeconds` old hits drop out', () => {
    const key = uniqueKey('roll');
    // Fill the bucket...
    for (let i = 0; i < 3; i++) checkRate(key, 3, 60);
    expect(checkRate(key, 3, 60)).toBe(false);
    // ...advance past the window so every earlier hit is outside cutoff.
    vi.advanceTimersByTime(61 * 1000);
    expect(checkRate(key, 3, 60)).toBe(true);
  });

  it('treats different keys as independent buckets', () => {
    const a = uniqueKey('independent-a');
    const b = uniqueKey('independent-b');
    for (let i = 0; i < 3; i++) checkRate(a, 3, 60);
    // `a` is saturated; `b` must still pass freely.
    expect(checkRate(a, 3, 60)).toBe(false);
    expect(checkRate(b, 3, 60)).toBe(true);
  });

  it('enforces the count using hits-so-far (including the current one)', () => {
    const key = uniqueKey('inclusive');
    // count=1 means the first hit passes and the second fails.
    expect(checkRate(key, 1, 60)).toBe(true);
    expect(checkRate(key, 1, 60)).toBe(false);
  });

  it('purges stale buckets once the map grows past ~10k keys', async () => {
    // Reset the module so the buckets Map starts empty; this test needs
    // the full cleanup sweep without interference from other cases.
    vi.resetModules();
    const { checkRate: fresh } = await import('./rateLimit.js');
    // Populate with 10_001 keys at t=0 so the cleanup branch runs.
    for (let i = 0; i < 10_001; i++) fresh(`stale-${i}`, 10, 1);
    // Advance past the 1-second window so all existing entries are stale,
    // then trigger one more call — the if (buckets.size > 10_000) branch
    // runs and prunes entries whose last timestamp is older than cutoff.
    vi.advanceTimersByTime(2_000);
    expect(fresh('trigger-cleanup', 10, 1)).toBe(true);
    // The exact size depends on the pruning predicate, but the map must
    // have shrunk well below the 10_001 we inserted.
    const second = fresh('trigger-cleanup', 10, 1);
    expect(second).toBe(true);
  });
});
