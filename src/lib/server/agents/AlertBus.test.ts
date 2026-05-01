import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertBus, getAlertBus } from './AlertBus.js';
import type { AlertPayload } from './AgentRuntime.js';

const sample = (id: string, agentId = 'a-1'): AlertPayload => ({
  id,
  agentId,
  severity: 'info',
  reason: 'something',
  body: 'something happened',
  url: `/repos/r-1?agent=${agentId}`,
  ts: 1
});

describe('AlertBus', () => {
  let bus: AlertBus;
  beforeEach(() => {
    bus = new AlertBus();
  });
  afterEach(() => {
    bus.removeAllListeners();
  });

  it('fans out emitUserAlert to onUserAlert listeners', () => {
    const got: Array<[string, AlertPayload]> = [];
    bus.onUserAlert((uid, payload) => {
      got.push([uid, payload]);
    });

    const a = sample('alert-1');
    bus.emitUserAlert('user-1', a);
    expect(got).toEqual([['user-1', a]]);
  });

  it('supports multiple listeners', () => {
    const got: number[] = [];
    bus.onUserAlert(() => got.push(1));
    bus.onUserAlert(() => got.push(2));
    bus.emitUserAlert('u', sample('a'));
    expect(got.sort()).toEqual([1, 2]);
  });

  it('returns an unsubscribe closure that detaches the listener', () => {
    const got: number[] = [];
    const off = bus.onUserAlert(() => got.push(1));
    bus.emitUserAlert('u', sample('a'));
    off();
    bus.emitUserAlert('u', sample('b'));
    expect(got).toEqual([1]);
  });
});

describe('getAlertBus', () => {
  it('returns the same instance across calls', () => {
    const a = getAlertBus();
    const b = getAlertBus();
    expect(a).toBe(b);
  });

  it('has a high listener cap', () => {
    expect(getAlertBus().getMaxListeners()).toBeGreaterThan(100);
  });
});
