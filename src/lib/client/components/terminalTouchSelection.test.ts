import { describe, expect, it } from 'vitest';
import {
  cellToPixel,
  linearLength,
  normalizeEndpoints,
  pixelToCell,
  wordRangeAt,
  type Cell,
  type ScreenRect
} from './terminalTouchSelection.js';

// 80×24 grid rendered into an 800×480 box → 10px × 20px cells.
const rect: ScreenRect = { left: 100, top: 50, width: 800, height: 480 };
const COLS = 80;
const ROWS = 24;

describe('pixelToCell', () => {
  it('maps a pixel inside the box to the covering cell with absolute row', () => {
    // 3rd column (x 100+25 → col 2), 2nd visible row (y 50+30 → rowInView 1)
    const cell = pixelToCell(125, 80, rect, COLS, ROWS, 0);
    expect(cell).toEqual({ col: 2, row: 1 });
  });

  it('adds viewportY so rows are absolute buffer rows', () => {
    const cell = pixelToCell(125, 80, rect, COLS, ROWS, 500);
    expect(cell).toEqual({ col: 2, row: 501 });
  });

  it('clamps coordinates outside the box to the grid edges', () => {
    expect(pixelToCell(-1000, -1000, rect, COLS, ROWS, 10)).toEqual({ col: 0, row: 10 });
    expect(pixelToCell(1e6, 1e6, rect, COLS, ROWS, 10)).toEqual({
      col: COLS - 1,
      row: 10 + ROWS - 1
    });
  });
});

describe('cellToPixel', () => {
  it('round-trips the top-left corner of a cell back to pixels', () => {
    const px = cellToPixel({ col: 2, row: 1 }, rect, COLS, ROWS, 0);
    // top-left of col 2, row 1: 100 + 2*10, 50-relative → y is relative to rect
    expect(px.x).toBe(20);
    expect(px.y).toBe(20);
    expect(px.cellW).toBe(10);
    expect(px.cellH).toBe(20);
    expect(px.onScreen).toBe(true);
  });

  it('reports onScreen=false when the row is scrolled out of the viewport', () => {
    // absolute row 5 with viewportY 500 → far above the viewport
    expect(cellToPixel({ col: 0, row: 5 }, rect, COLS, ROWS, 500).onScreen).toBe(false);
    // row within [viewportY, viewportY+rows-1] is on screen
    expect(cellToPixel({ col: 0, row: 500 }, rect, COLS, ROWS, 500).onScreen).toBe(true);
    expect(cellToPixel({ col: 0, row: 523 }, rect, COLS, ROWS, 500).onScreen).toBe(true);
    expect(cellToPixel({ col: 0, row: 524 }, rect, COLS, ROWS, 500).onScreen).toBe(false);
  });
});

describe('wordRangeAt', () => {
  const line = 'foo bar(baz)';

  it('selects the whole word around the column', () => {
    expect(wordRangeAt(line, 0)).toEqual({ startCol: 0, endCol: 3 }); // "foo"
    expect(wordRangeAt(line, 5)).toEqual({ startCol: 4, endCol: 7 }); // "bar"
    expect(wordRangeAt(line, 9)).toEqual({ startCol: 8, endCol: 11 }); // "baz"
  });

  it('selects a single cell on a separator or space', () => {
    expect(wordRangeAt(line, 3)).toEqual({ startCol: 3, endCol: 4 }); // space
    expect(wordRangeAt(line, 7)).toEqual({ startCol: 7, endCol: 8 }); // "("
  });

  it('selects a single cell past the end of the line', () => {
    expect(wordRangeAt(line, 40)).toEqual({ startCol: 40, endCol: 41 });
  });

  it('handles a word butting against the start and end of the line', () => {
    expect(wordRangeAt('hello', 2)).toEqual({ startCol: 0, endCol: 5 });
  });
});

describe('linearLength', () => {
  it('counts cells on a single row', () => {
    expect(linearLength({ col: 4, row: 10 }, { col: 7, row: 10 }, COLS)).toBe(3);
  });

  it('wraps across rows by cols (xterm select() semantics)', () => {
    // start (col 70, row 10) → end (col 5, row 12): 2 full rows + (5-70)
    expect(linearLength({ col: 70, row: 10 }, { col: 5, row: 12 }, COLS)).toBe(
      2 * COLS + (5 - 70)
    );
  });
});

describe('normalizeEndpoints', () => {
  const a: Cell = { col: 10, row: 5 };
  const b: Cell = { col: 2, row: 8 };

  it('orders by row then column regardless of input order', () => {
    expect(normalizeEndpoints(a, b)).toEqual({ start: a, end: b });
    expect(normalizeEndpoints(b, a)).toEqual({ start: a, end: b });
  });

  it('orders by column when rows are equal', () => {
    const left: Cell = { col: 3, row: 7 };
    const right: Cell = { col: 9, row: 7 };
    expect(normalizeEndpoints(right, left)).toEqual({ start: left, end: right });
  });
});
