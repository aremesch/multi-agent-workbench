import { describe, expect, it } from 'vitest';
import { sanitizeCapabilityValue } from './capabilityValidation.js';
import type { AdapterCapabilityListing } from './AdapterRegistry.js';

const cap: AdapterCapabilityListing = {
  label: 'Model',
  default: 'sonnet',
  values: [
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' }
  ]
};

describe('sanitizeCapabilityValue', () => {
  it('returns null when capability is null', () => {
    expect(sanitizeCapabilityValue(null, 'opus')).toBeNull();
  });

  it('returns null for null / undefined input', () => {
    expect(sanitizeCapabilityValue(cap, null)).toBeNull();
    expect(sanitizeCapabilityValue(cap, undefined)).toBeNull();
  });

  it('returns null for empty / whitespace string', () => {
    expect(sanitizeCapabilityValue(cap, '')).toBeNull();
    expect(sanitizeCapabilityValue(cap, '   ')).toBeNull();
  });

  it('returns null for non-string types', () => {
    expect(sanitizeCapabilityValue(cap, 42)).toBeNull();
    expect(sanitizeCapabilityValue(cap, true)).toBeNull();
    expect(sanitizeCapabilityValue(cap, { id: 'opus' })).toBeNull();
  });

  it('returns null when the value does not match any allowed id', () => {
    expect(sanitizeCapabilityValue(cap, 'haiku')).toBeNull();
    expect(sanitizeCapabilityValue(cap, 'OPUS')).toBeNull(); // case-sensitive
  });

  it('returns the trimmed id when valid', () => {
    expect(sanitizeCapabilityValue(cap, 'opus')).toBe('opus');
    expect(sanitizeCapabilityValue(cap, '  sonnet  ')).toBe('sonnet');
  });
});
