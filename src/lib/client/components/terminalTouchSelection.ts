/**
 * Pure geometry & word-boundary helpers for the mobile touch text-selection
 * gestures in `Terminal.svelte`. Kept free of DOM and xterm imports so the
 * math is unit-testable in isolation.
 *
 * Coordinate spaces:
 * - "cell" coords are grid cells: `col` is 0-based (0 … cols-1), `row` is an
 *   ABSOLUTE buffer row (0 = top of scrollback), matching what xterm's
 *   `term.select(col, row, length)` and `getSelectionPosition()` use.
 * - `viewportY` is `term.buffer.active.viewportY` — the absolute buffer row
 *   currently shown at the top of the viewport — used to map absolute rows to
 *   on-screen rows and back.
 */

/** A grid cell endpoint of a selection. `col` 0-based, `row` absolute buffer row. */
export type Cell = { col: number; row: number };

/** Minimal rectangle (a DOMRect-like) of the rendered terminal screen. */
export type ScreenRect = { left: number; top: number; width: number; height: number };

/**
 * xterm's default `wordSeparator` set plus whitespace. A long-press over a
 * word selects the run of non-separator characters around the finger; a
 * long-press over a separator selects just that single cell.
 */
export const DEFAULT_WORD_SEPARATORS = " \t()[]{}',\"`";

/** Pixel size of a single grid cell. */
export function cellSize(
  rect: ScreenRect,
  cols: number,
  rows: number
): { cellW: number; cellH: number } {
  return {
    cellW: cols > 0 ? rect.width / cols : 0,
    cellH: rows > 0 ? rect.height / rows : 0
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Map a viewport pixel coordinate to the cell under it, clamped to the grid.
 * Returns an absolute buffer row (viewportY + on-screen row).
 */
export function pixelToCell(
  clientX: number,
  clientY: number,
  rect: ScreenRect,
  cols: number,
  rows: number,
  viewportY: number
): Cell {
  const { cellW, cellH } = cellSize(rect, cols, rows);
  const col = cellW > 0 ? Math.floor((clientX - rect.left) / cellW) : 0;
  const rowInView = cellH > 0 ? Math.floor((clientY - rect.top) / cellH) : 0;
  return {
    col: clamp(col, 0, Math.max(0, cols - 1)),
    row: viewportY + clamp(rowInView, 0, Math.max(0, rows - 1))
  };
}

/**
 * Inverse of {@link pixelToCell}: the top-left pixel of a cell's box, relative
 * to `rect`. `onScreen` is false when the absolute row is scrolled out of the
 * viewport, so the caller can hide that handle.
 */
export function cellToPixel(
  cell: Cell,
  rect: ScreenRect,
  cols: number,
  rows: number,
  viewportY: number
): { x: number; y: number; cellW: number; cellH: number; onScreen: boolean } {
  const { cellW, cellH } = cellSize(rect, cols, rows);
  const rowInView = cell.row - viewportY;
  return {
    x: cell.col * cellW,
    y: rowInView * cellH,
    cellW,
    cellH,
    onScreen: rowInView >= 0 && rowInView <= rows - 1
  };
}

/**
 * Expand to the word around `col` in `lineText`. Returns an inclusive-start /
 * exclusive-end column range `[startCol, endCol)`. Over a separator or past
 * the end of the line, selects a single cell.
 */
export function wordRangeAt(
  lineText: string,
  col: number,
  separators: string = DEFAULT_WORD_SEPARATORS
): { startCol: number; endCol: number } {
  const isSep = (ch: string): boolean => ch === '' || separators.includes(ch);
  if (col < 0) return { startCol: 0, endCol: 1 };
  if (col >= lineText.length || isSep(lineText[col]!)) {
    return { startCol: col, endCol: col + 1 };
  }
  let start = col;
  let end = col;
  while (start > 0 && !isSep(lineText[start - 1]!)) start--;
  while (end < lineText.length - 1 && !isSep(lineText[end + 1]!)) end++;
  return { startCol: start, endCol: end + 1 };
}

/**
 * Linear cell count between two ordered endpoints, matching xterm's
 * `select(col, row, length)` semantics where `length` wraps across rows by
 * `cols`. `start` must be before `end` (see {@link normalizeEndpoints}).
 */
export function linearLength(start: Cell, end: Cell, cols: number): number {
  return (end.row - start.row) * cols + (end.col - start.col);
}

/** Order two endpoints so `start` precedes `end` (by row, then column). */
export function normalizeEndpoints(a: Cell, b: Cell): { start: Cell; end: Cell } {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) {
    return { start: a, end: b };
  }
  return { start: b, end: a };
}
