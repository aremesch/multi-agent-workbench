import type { Page } from '@playwright/test';

/**
 * Snapshot of the attached xterm.js instance as seen from the browser. Covers
 * exactly what we assert against: cursor position plus every visible line and
 * the top slice of scrollback (as plain text, trailing whitespace stripped).
 */
export interface TerminalSnapshot {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  bufferLength: number;
  viewportY: number;
  lines: string[];
}

/**
 * Read the current state of the xterm instance the page exposes via
 * `window.__maw_xterm` (dev-only hook — see Terminal.svelte). Rejects if the
 * hook isn't present, which means the Terminal component hasn't mounted yet
 * — callers should `openAgentPage` first to await the mount.
 */
export async function readTerminal(page: Page): Promise<TerminalSnapshot> {
  return page.evaluate<TerminalSnapshot>(() => {
    interface XBufferLine {
      translateToString(trimRight?: boolean): string;
    }
    interface XBuffer {
      cursorX: number;
      cursorY: number;
      viewportY: number;
      length: number;
      getLine(i: number): XBufferLine | undefined;
    }
    interface XTermLike {
      cols: number;
      rows: number;
      buffer: { active: XBuffer };
    }
    const term = (window as unknown as { __maw_xterm?: XTermLike }).__maw_xterm;
    if (!term) throw new Error('window.__maw_xterm not present');
    const buf = term.buffer.active;
    const lines: string[] = [];
    const start = buf.viewportY;
    for (let i = 0; i < term.rows; i++) {
      const line = buf.getLine(start + i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return {
      cols: term.cols,
      rows: term.rows,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      bufferLength: buf.length,
      viewportY: buf.viewportY,
      lines
    };
  });
}

/**
 * Poll the terminal until `predicate(snapshot)` returns true or we time out.
 * Throws with the last snapshot on timeout so failures show what the grid
 * actually contained instead of a generic "timed out" message.
 */
export async function waitForTerminal(
  page: Page,
  predicate: (snap: TerminalSnapshot) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<TerminalSnapshot> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const interval = opts.intervalMs ?? 150;
  let last: TerminalSnapshot | null = null;
  while (Date.now() < deadline) {
    last = await readTerminal(page);
    if (predicate(last)) return last;
    await page.waitForTimeout(interval);
  }
  const label = opts.label ?? 'predicate';
  throw new Error(
    `waitForTerminal timed out on ${label}. last snapshot:\n${JSON.stringify(last, null, 2)}`
  );
}
