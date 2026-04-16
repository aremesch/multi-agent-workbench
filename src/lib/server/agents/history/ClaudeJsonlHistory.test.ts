import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCwdForClaude, jsonlPathFor } from './ClaudeJsonlHistory.js';

// `renderClaudeJsonlHistory` (the file-I/O + JSONL rendering pipeline) is
// covered in Phase 4. This file is Phase 1 — the two pure path helpers.

describe('encodeCwdForClaude', () => {
  it('replaces slashes with hyphens', () => {
    expect(encodeCwdForClaude('/home/ar/workspace/proj')).toBe('-home-ar-workspace-proj');
  });

  it('replaces dots with hyphens', () => {
    expect(encodeCwdForClaude('/a/b/c.d.e')).toBe('-a-b-c-d-e');
  });

  it('leaves other punctuation and spaces intact', () => {
    expect(encodeCwdForClaude('/foo bar/baz')).toBe('-foo bar-baz');
    expect(encodeCwdForClaude('/my_repo-v2')).toBe('-my_repo-v2');
  });

  it('is a total pure transform', () => {
    expect(encodeCwdForClaude('')).toBe('');
    expect(encodeCwdForClaude('no-sep')).toBe('no-sep');
  });
});

describe('jsonlPathFor', () => {
  it('joins ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl', () => {
    const cwd = '/home/ar/workspace/maw';
    const sid = '01JXYZ';
    const expected = join(
      homedir(),
      '.claude',
      'projects',
      '-home-ar-workspace-maw',
      '01JXYZ.jsonl'
    );
    expect(jsonlPathFor(cwd, sid)).toBe(expected);
  });

  it('encodes dots in the cwd path', () => {
    const out = jsonlPathFor('/foo.bar/baz', 'id');
    expect(out).toContain('-foo-bar-baz');
    expect(out.endsWith('/id.jsonl')).toBe(true);
  });
});
