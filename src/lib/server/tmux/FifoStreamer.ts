/**
 * FIFO-backed terminal streamer.
 *
 * Creates a named pipe at <fifoDir>/fifo-<agentId>, opens it for reading, and
 * emits Buffer chunks via a callback whenever tmux's `pipe-pane 'cat >> ...'`
 * writes into the pipe.
 *
 * Design notes:
 *   - `open(path, 'r')` on a FIFO blocks in the kernel until a writer
 *     appears. We avoid that by opening O_RDWR: kernel treats us as both
 *     ends, so open() returns immediately AND the pipe never hits EOF when
 *     tmux's pipe-pane writer restarts across backend reconnects (our own
 *     O_RDWR fd always counts as a live writer).
 *   - Reads are BLOCKING (no O_NONBLOCK). Node's ReadStream dispatches
 *     reads through libuv's threadpool, which does blocking read(2) off the
 *     event loop; that's the path that handles arbitrary fds cleanly. With
 *     O_NONBLOCK set, an empty pipe returns EAGAIN and Node's stream layer
 *     (which has no retry-on-EAGAIN for arbitrary fds) emits 'error' and
 *     crashes the process.
 *   - Cleanup: on stop(), destroy the stream, close the fd, unlink the fifo.
 */

import { mkdirSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs';
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
    // O_RDWR (no O_NONBLOCK): non-blocking open thanks to being our own
    // writer, blocking reads dispatched via libuv threadpool. See header.
    // 'r+' is the node fs shorthand for O_RDWR.
    this.fd = openSync(this.path, 'r+');
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
