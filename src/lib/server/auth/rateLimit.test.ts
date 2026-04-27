import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRate } from './rateLimit.js';

describe('checkRate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to `count` hits in the window then rejects further hits', () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRate('test:a', 5, 60)).toBe(true);
    }
    expect(checkRate('test:a', 5, 60)).toBe(false);
  });

  it('lets old hits expire after the window passes', () => {
    for (let i = 0; i < 5; i++) checkRate('test:b', 5, 60);
    vi.advanceTimersByTime(61 * 1000);
    expect(checkRate('test:b', 5, 60)).toBe(true);
  });

  it('keys are independent', () => {
    for (let i = 0; i < 5; i++) checkRate('test:c', 5, 60);
    expect(checkRate('test:c', 5, 60)).toBe(false);
    expect(checkRate('test:d', 5, 60)).toBe(true);
  });
});
