import { describe, expect, it } from 'vitest';
import { formatDuration, formatDurationHMS, formatTimestamp } from './format.js';

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [1, '1s'],
    [59, '59s'],
    [60, '1m 0s'],
    [61, '1m 1s'],
    [3599, '59m 59s'],
    [3600, '1h 0m'],
    [3661, '1h 1m'],
    [86399, '23h 59m'],
    [86400, '1d 0h'],
    [90000, '1d 1h']
  ])('formatDuration(%i) === %s', (sec, expected) => {
    expect(formatDuration(sec)).toBe(expected);
  });

  it('returns — for null / undefined / negative / non-finite', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Infinity)).toBe('—');
    expect(formatDuration(-Infinity)).toBe('—');
    expect(formatDuration(NaN)).toBe('—');
  });

  it('floors fractional seconds', () => {
    expect(formatDuration(59.9)).toBe('59s');
    expect(formatDuration(60.5)).toBe('1m 0s');
  });
});

describe('formatDurationHMS', () => {
  it.each([
    [0, '0:00'],
    [1, '0:01'],
    [59, '0:59'],
    [60, '1:00'],
    [61, '1:01'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3661, '1:01:01'],
    [86400, '24:00:00']
  ])('formatDurationHMS(%i) === %s', (sec, expected) => {
    expect(formatDurationHMS(sec)).toBe(expected);
  });

  it('returns — for null / undefined / negative / non-finite', () => {
    expect(formatDurationHMS(null)).toBe('—');
    expect(formatDurationHMS(undefined)).toBe('—');
    expect(formatDurationHMS(-5)).toBe('—');
    expect(formatDurationHMS(NaN)).toBe('—');
  });

  it('pads minutes and seconds to two digits', () => {
    expect(formatDurationHMS(65)).toBe('1:05');
    expect(formatDurationHMS(3605)).toBe('1:00:05');
  });
});

describe('formatTimestamp', () => {
  it('returns — for null / undefined', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp(undefined)).toBe('—');
  });

  it('renders epoch seconds via Date.toLocaleString', () => {
    // Locale-sensitive, but both implementation and test use the same fn,
    // so we compare against the platform locale output directly.
    expect(formatTimestamp(0)).toBe(new Date(0).toLocaleString());
    expect(formatTimestamp(1_700_000_000)).toBe(
      new Date(1_700_000_000 * 1000).toLocaleString()
    );
  });
});
