import { describe, expect, it } from 'vitest';
import { collapseRepeatingTailBlocks } from './hub.js';

describe('collapseRepeatingTailBlocks', () => {
  it('returns input unchanged when there are no repeats', () => {
    const input = 'a\nb\nc\nd\ne';
    expect(collapseRepeatingTailBlocks(input)).toBe(input);
  });

  it('collapses a pure tail repeat', () => {
    const input = 'a\nb\nX\nY\nZ\nX\nY\nZ';
    expect(collapseRepeatingTailBlocks(input)).toBe('a\nb\nX\nY\nZ');
  });

  it('collapses 2-line repeats iteratively', () => {
    // ['p','q','q','q','q']: k=2 match on tail → splice → ['p','q','q'].
    // Then maxK=1 → loop exits.
    expect(collapseRepeatingTailBlocks('p\nq\nq\nq\nq')).toBe('p\nq\nq');
  });

  it('ignores single-line repeats (k >= 2 only)', () => {
    // A dup of length 1 at the tail is ambiguous (could be genuine repeat),
    // so the algorithm leaves it alone.
    expect(collapseRepeatingTailBlocks('a\nb\nb')).toBe('a\nb\nb');
  });

  it('prefers the largest matching k first', () => {
    // ['x','y','x','y','x','y']: k=3 matches ['x','y','x'] vs ['y','x','y']? No.
    // k=2 matches last 2 ['x','y'] vs prev 2 ['x','y'] → splice.
    // Continues collapsing until 2-or-fewer remain.
    const out = collapseRepeatingTailBlocks('x\ny\nx\ny\nx\ny');
    expect(out).toBe('x\ny');
  });

  it('handles empty string', () => {
    expect(collapseRepeatingTailBlocks('')).toBe('');
  });

  it('terminates in reasonable time on a 500-line non-repeating input', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    const input = lines.join('\n');
    const start = Date.now();
    const out = collapseRepeatingTailBlocks(input);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).toBe(input);
  });
});
