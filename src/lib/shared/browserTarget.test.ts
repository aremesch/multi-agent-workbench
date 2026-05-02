import { describe, expect, it } from 'vitest';
import {
  CODING_CLI_KINDS,
  isAnyBrowserKind,
  isCodingCliKind,
  parseBrowserTargetUrl
} from './browserTarget.js';

describe('isAnyBrowserKind', () => {
  it.each([
    ['browser', true],
    ['browser-stream', true],
    ['claude-code', false],
    ['codex', false],
    ['gemini', false],
    ['shell', false],
    ['', false]
  ])('isAnyBrowserKind(%s) === %s', (kind, expected) => {
    expect(isAnyBrowserKind(kind)).toBe(expected);
  });
});

describe('isCodingCliKind', () => {
  it.each([
    ['claude-code', true],
    ['codex', true],
    ['gemini', true],
    ['shell', false],
    ['browser', false],
    ['browser-stream', false],
    ['', false],
    ['CLAUDE-CODE', false] // case-sensitive — adapter kinds are lowercase
  ])('isCodingCliKind(%s) === %s', (kind, expected) => {
    expect(isCodingCliKind(kind)).toBe(expected);
  });

  it('CODING_CLI_KINDS lists exactly the three CLI coding adapters', () => {
    expect([...CODING_CLI_KINDS].sort()).toEqual(['claude-code', 'codex', 'gemini']);
  });
});

describe('parseBrowserTargetUrl — sanity', () => {
  it('parses http://localhost:5173', () => {
    const r = parseBrowserTargetUrl('http://localhost:5173');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.port).toBe(5173);
  });

  it('rejects https URLs', () => {
    const r = parseBrowserTargetUrl('https://localhost:5173');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('scheme');
  });
});
