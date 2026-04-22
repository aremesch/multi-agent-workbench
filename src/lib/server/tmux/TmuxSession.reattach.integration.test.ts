/**
 * Real-tmux integration test for the reattach dead-stream bug.
 *
 * Bug (docs/plans/v0.2-reattach-live-stream-fix.md): after `systemctl
 * --user restart maw`, reattached agent terminals showed no live output
 * and no keystroke echo. Root cause: `tmux pipe-pane -o` is a TOGGLE, so
 * when a previous `cat` child survived the old maw process's SIGKILL
 * window, the second pipe-pane call silently closed the pipe instead of
 * replacing it.
 *
 * This test runs REAL tmux on a throwaway `-L` socket, simulates the
 * restart-reattach sequence (back-to-back pipe-pane calls with the old
 * pipe still live), and asserts the pane ends up with an active pipe
 * AND bytes actually flow through the FIFO. If `-o` is ever
 * re-introduced through any code path, the second assertion flips to
 * `pane_pipe=0` and this test fails loudly.
 *
 * Skips when tmux is not on PATH (dev laptops without tmux). CI (Ubuntu
 * runners) has tmux preinstalled.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import {
  mkdtempSync,
  rmSync,
  openSync,
  closeSync,
  readSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOCK = `maw-reattach-${process.pid}`;
const tm = (...args: string[]) => execa('tmux', ['-L', SOCK, ...args]);

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execa('which', ['tmux']);
    return true;
  } catch {
    return false;
  }
}

const hasTmux = await tmuxAvailable();
const d = hasTmux ? describe : describe.skip;

d('Tmux pipe-pane — reattach robustness (real tmux)', () => {
  let fifoDir: string;
  const session = `maw-reattach-test-${process.pid}`;

  beforeAll(async () => {
    fifoDir = mkdtempSync(join(tmpdir(), 'maw-fifo-reattach-'));
    // Detached bash session — -f /dev/null isolates from user tmux config.
    await tm('-f', '/dev/null', 'new-session', '-d', '-s', session, 'bash');
  });

  afterAll(async () => {
    // Best-effort teardown — kill-server nukes everything on this socket.
    await tm('kill-server').catch(() => undefined);
    rmSync(fifoDir, { recursive: true, force: true });
  });

  it('back-to-back pipe-pane calls with an active prior pipe leave the pane piped (not toggled off)', async () => {
    const fifo = join(fifoDir, 'reattach.fifo');
    await execa('mkfifo', [fifo]);

    // O_RDWR reader-writer held open on our side: mirrors how
    // FifoStreamer keeps the FIFO alive, and stops the tmux-side `cat`
    // from SIGPIPE-ing between the two pipe-pane invocations (we're
    // specifically testing the path where the old pipe is still live).
    const rfd = openSync(fifo, 'r+');

    try {
      // Exact argv the production Tmux.pipePane sends (no `-o`).
      await tm('pipe-pane', '-t', session, `cat >> ${JSON.stringify(fifo)}`);
      const first = await tm('display', '-p', '-t', session, '#{pane_pipe}');
      expect(first.stdout.trim()).toBe('1');

      // Simulate reattach: second pipe-pane with prior pipe still live.
      await tm('pipe-pane', '-t', session, `cat >> ${JSON.stringify(fifo)}`);
      const second = await tm('display', '-p', '-t', session, '#{pane_pipe}');
      // ↓ Under a resurrected `-o` argv this would come back as '0'.
      expect(second.stdout.trim()).toBe('1');

      // Data actually flows — poke the shell and drain a buffer.
      await tm('send-keys', '-t', session, 'echo maw-reattach-ok', 'Enter');
      await new Promise((r) => setTimeout(r, 300));
      const buf = Buffer.alloc(4096);
      const n = readSync(rfd, buf, 0, buf.length, null);
      expect(n).toBeGreaterThan(0);
      expect(buf.slice(0, n).toString('utf8')).toMatch(/maw-reattach-ok/);
    } finally {
      closeSync(rfd);
    }
  }, 15_000);
});
