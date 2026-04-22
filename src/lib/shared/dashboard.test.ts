import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOBILE_QUICK_KEYS_MODE,
  isMobileQuickKeysMode,
  parseMobileQuickKeysMode
} from './dashboard.js';

describe('isMobileQuickKeysMode', () => {
  it('recognises the three known modes', () => {
    expect(isMobileQuickKeysMode('auto')).toBe(true);
    expect(isMobileQuickKeysMode('always')).toBe(true);
    expect(isMobileQuickKeysMode('never')).toBe(true);
  });

  it('rejects other strings and non-strings', () => {
    expect(isMobileQuickKeysMode('sometimes')).toBe(false);
    expect(isMobileQuickKeysMode('')).toBe(false);
    expect(isMobileQuickKeysMode(null)).toBe(false);
    expect(isMobileQuickKeysMode(undefined)).toBe(false);
    expect(isMobileQuickKeysMode(1)).toBe(false);
    expect(isMobileQuickKeysMode({})).toBe(false);
  });
});

describe('parseMobileQuickKeysMode', () => {
  it('falls back to the default on null/undefined/empty string', () => {
    expect(parseMobileQuickKeysMode(null)).toBe(DEFAULT_MOBILE_QUICK_KEYS_MODE);
    expect(parseMobileQuickKeysMode(undefined)).toBe(DEFAULT_MOBILE_QUICK_KEYS_MODE);
    expect(parseMobileQuickKeysMode('')).toBe(DEFAULT_MOBILE_QUICK_KEYS_MODE);
  });

  it('accepts a JSON-stringified known mode', () => {
    expect(parseMobileQuickKeysMode('"auto"')).toBe('auto');
    expect(parseMobileQuickKeysMode('"always"')).toBe('always');
    expect(parseMobileQuickKeysMode('"never"')).toBe('never');
  });

  it('accepts a bare mode string (legacy key shape)', () => {
    expect(parseMobileQuickKeysMode('always')).toBe('always');
    expect(parseMobileQuickKeysMode('never')).toBe('never');
  });

  it('falls back to the default on unknown values', () => {
    expect(parseMobileQuickKeysMode('"sometimes"')).toBe(DEFAULT_MOBILE_QUICK_KEYS_MODE);
    expect(parseMobileQuickKeysMode('sometimes')).toBe(DEFAULT_MOBILE_QUICK_KEYS_MODE);
    expect(parseMobileQuickKeysMode('{ broken json')).toBe(DEFAULT_MOBILE_QUICK_KEYS_MODE);
  });
});
