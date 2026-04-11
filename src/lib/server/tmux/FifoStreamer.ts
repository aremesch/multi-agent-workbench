/**
 * FIFO-backed terminal streamer.
 *
 * Creates a named pipe at <fifoDir>/fifo-<agentId>, opens it for reading, and
 * emits Buffer chunks via a callback whenever tmux's `pipe-pane 'cat >> ...'`
 * writes into the pipe.
 *
 * Design notes:
 *   - `open(path, 'r')` on a FIFO blocks until a writer appears. To avoid
 *     that we open with O_RDWR (we never write, but the flag gives us a
 *     non-blocking open even when no writer exists yet).
 *   - Re-open on close (`readable.on('end')`) in case the pipe-pane writer
 *     restarts across backend reconnects — no-op in practice since we hold
 *     O_RDWR, but cheap insurance.
 *   - Cleanup: on stop(), close the fd and unlink the fifo.
 */

import { mkdirSync, existsSync, unlinkSync, openSync, closeSync, constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { EventEmitter } from 'node:events';

export interface FifoStreamerOptions {
  fifoDir: string;
  agentId: string;
}

export class FifoStreamer extends EventEmitter {
  readonly path: string;
  private fd: number | null = null;
  private stream: import('node:fs').ReadStream | null = null;

  constructor(private readonly opts: FifoStreamerOptions) {
    super();
    this.path = join(opts.fifoDir, `fifo-${opts.agentId}`);
  }

  async create(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      // mkfifo is not in node's fs; shell out.
      await execa('mkfifo', [this.path]);
    }
  }

  /** Begin streaming. Calls back with each Buffer chunk tmux writes into the fifo. */
  start(onChunk: (chunk: Buffer) => void): void {
    if (this.fd !== null) return;
    // O_RDWR prevents blocking when there's no writer yet.
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_NONBLOCK);
    this.stream = createReadStream('', { fd: this.fd, autoClose: false });
    this.stream.on('data', (chunk) => {
      onChunk(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    this.stream.on('error', (err) => this.emit('error', err));
  }

  async stop(): Promise<void> {
    try {
      this.stream?.destroy();
    } catch {
      // ignore
    }
    this.stream = null;
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      // ignore
    }
  }
}
