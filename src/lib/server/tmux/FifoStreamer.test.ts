import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// -----------------------------------------------------------------------------
// Mocks. execa is mocked for the mkfifo call; node:fs is mocked for the
// openSync/createReadStream pair so we can observe flags + inject a fake
// stream without needing a real FIFO on the filesystem.
//
// Regression guard: FifoStreamer must open with 'r+' (O_RDWR). The original
// 'r' variant blocks libuv threadpool on empty pipes and eventually crashes
// with EAGAIN — CLAUDE.md notes this as a real past incident.
// -----------------------------------------------------------------------------

const execaMock = vi.fn();
vi.mock('execa', () => ({
  execa: (cmd: string, args: string[]) => execaMock(cmd, args)
}));

const mkdirSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const openSyncMock = vi.fn();
const closeSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const createReadStreamMock = vi.fn();

vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...real,
    mkdirSync: (...a: unknown[]) => mkdirSyncMock(...a),
    existsSync: (...a: unknown[]) => existsSyncMock(...a),
    openSync: (...a: unknown[]) => openSyncMock(...a),
    closeSync: (...a: unknown[]) => closeSyncMock(...a),
    unlinkSync: (...a: unknown[]) => unlinkSyncMock(...a),
    createReadStream: (...a: unknown[]) => createReadStreamMock(...a)
  };
});

import { FifoStreamer } from './FifoStreamer.js';

/** Minimal fake for node:fs#createReadStream — emits data + supports destroy. */
class FakeStream extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
  emitData(chunk: Buffer | string): void {
    this.emit('data', chunk);
  }
  emitError(err: Error): void {
    this.emit('error', err);
  }
}

beforeEach(() => {
  execaMock.mockReset();
  mkdirSyncMock.mockReset();
  existsSyncMock.mockReset();
  openSyncMock.mockReset();
  closeSyncMock.mockReset();
  unlinkSyncMock.mockReset();
  createReadStreamMock.mockReset();
});

describe('FifoStreamer.path', () => {
  it('is <fifoDir>/fifo-<agentId>', () => {
    const s = new FifoStreamer({ fifoDir: '/tmp/fifos', agentId: '01ABC' });
    expect(s.path).toBe('/tmp/fifos/fifo-01ABC');
  });
});

describe('FifoStreamer.create', () => {
  it('mkdirs the fifo directory with { recursive: true }', async () => {
    existsSyncMock.mockReturnValue(false);
    execaMock.mockResolvedValueOnce({ stdout: '' });
    const s = new FifoStreamer({ fifoDir: '/tmp/fifos/nested', agentId: 'a' });
    await s.create();
    expect(mkdirSyncMock).toHaveBeenCalledWith('/tmp/fifos/nested', { recursive: true });
  });

  it('shells out to mkfifo when the pipe does not exist yet', async () => {
    existsSyncMock.mockReturnValue(false);
    execaMock.mockResolvedValueOnce({ stdout: '' });
    const s = new FifoStreamer({ fifoDir: '/tmp/fifos', agentId: 'a' });
    await s.create();
    expect(execaMock).toHaveBeenCalledWith('mkfifo', ['/tmp/fifos/fifo-a']);
  });

  it('unlinks and re-creates the pipe when a stale FIFO is already on disk (reattach fresh-inode guarantee)', async () => {
    // Regression guard for the reattach dead-stream bug: if a prior maw
    // process was SIGKILL'd before it could call stop(), the stale FIFO
    // file may still be bound to a surviving tmux-side `cat` writer.
    // create() MUST replace it so the new reader attaches to a fresh
    // kernel FIFO with no stray state from the old lifetime.
    // See docs/plans/v0.2-reattach-live-stream-fix.md.
    existsSyncMock.mockReturnValue(true);
    execaMock.mockResolvedValueOnce({ stdout: '' });
    const s = new FifoStreamer({ fifoDir: '/tmp/fifos', agentId: 'a' });
    await s.create();
    expect(unlinkSyncMock).toHaveBeenCalledWith('/tmp/fifos/fifo-a');
    expect(execaMock).toHaveBeenCalledWith('mkfifo', ['/tmp/fifos/fifo-a']);
    // mkfifo runs AFTER unlink.
    const unlinkOrder = unlinkSyncMock.mock.invocationCallOrder[0]!;
    const mkfifoOrder = execaMock.mock.invocationCallOrder[0]!;
    expect(unlinkOrder).toBeLessThan(mkfifoOrder);
  });

  it('still mkfifos (without unlinking) when the path does not yet exist', async () => {
    existsSyncMock.mockReturnValue(false);
    execaMock.mockResolvedValueOnce({ stdout: '' });
    const s = new FifoStreamer({ fifoDir: '/tmp/fifos', agentId: 'a' });
    await s.create();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(execaMock).toHaveBeenCalledWith('mkfifo', ['/tmp/fifos/fifo-a']);
  });

  it('swallows unlink errors — mkfifo still runs (racing cleanup is fine)', async () => {
    existsSyncMock.mockReturnValue(true);
    unlinkSyncMock.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    execaMock.mockResolvedValueOnce({ stdout: '' });
    const s = new FifoStreamer({ fifoDir: '/tmp/fifos', agentId: 'a' });
    await expect(s.create()).resolves.toBeUndefined();
    expect(execaMock).toHaveBeenCalledWith('mkfifo', ['/tmp/fifos/fifo-a']);
  });
});

describe('FifoStreamer.start — open flags regression', () => {
  it('opens with the "r+" flag (O_RDWR) — NOT "r"/O_NONBLOCK', () => {
    // The 'r' variant triggered an EAGAIN crash in production; locking the
    // open flag here is the cheapest guard available.
    openSyncMock.mockReturnValue(7);
    createReadStreamMock.mockReturnValue(new FakeStream());
    const s = new FifoStreamer({ fifoDir: '/d', agentId: 'a' });
    s.start(() => undefined);
    expect(openSyncMock).toHaveBeenCalledWith('/d/fifo-a', 'r+');
  });

  it('start is idempotent — a second call while open is a no-op', () => {
    openSyncMock.mockReturnValue(7);
    createReadStreamMock.mockReturnValue(new FakeStream());
    const s = new FifoStreamer({ fifoDir: '/d', agentId: 'a' });
    s.start(() => undefined);
    s.start(() => undefined);
    expect(openSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe('FifoStreamer.start — data delivery', () => {
  it('forwards each stream `data` Buffer chunk to the callback', () => {
    openSyncMock.mockReturnValue(3);
    const fake = new FakeStream();
    createReadStreamMock.mockReturnValue(fake);
    const s = new FifoStreamer({ fifoDir: '/d', agentId: 'a' });
    const chunks: Buffer[] = [];
    s.start((c) => chunks.push(c));
    fake.emitData(Buffer.from('hello '));
    fake.emitData(Buffer.from('world'));
    expect(chunks.map((b) => b.toString('utf8'))).toEqual(['hello ', 'world']);
  });

  it('converts string chunks to Buffer (defensive — should normally arrive as Buffer)', () => {
    openSyncMock.mockReturnValue(3);
    const fake = new FakeStream();
    createReadStreamMock.mockReturnValue(fake);
    const s = new FifoStreamer({ fifoDir: '/d', agentId: 'a' });
    const chunks: Buffer[] = [];
    s.start((c) => chunks.push(c));
    fake.emitData('plain string');
    expect(chunks).toHaveLength(1);
    expect(Buffer.isBuffer(chunks[0])).toBe(true);
    expect(chunks[0].toString('utf8')).toBe('plain string');
  });

  it('re-emits stream `error` events as its own "error" event', () => {
    openSyncMock.mockReturnValue(3);
    const fake = new FakeStream();
    createReadStreamMock.mockReturnValue(fake);
    const s = new FifoStreamer({ fifoDir: '/d', agentId: 'a' });
    const err = new Error('boom');
    const errs: Error[] = [];
    s.on('error', (e) => errs.push(e));
    s.start(() => undefined);
    fake.emitError(err);
    expect(errs).toEqual([err]);
  });
});

describe('FifoStreamer.stop', () => {
  it('destroys the stream, closes the fd, unlinks the fifo', async () => {
    openSyncMock.mockReturnValue(5);
    const fake = new FakeStream();
    createReadStreamMock.mockReturnValue(fake);
    existsSyncMock.mockReturnValue(true);

    const s = new FifoStreamer({ fifoDir: '/d', agentId: 'a' });
    s.start(() => undefined);
    await s.stop();

    expect(fake.destroyed).toBe(true);
    expect(closeSyncMock).toHaveBeenCalledWith(5);
    expect(unlinkSyncMock).toHaveBeenCalledWith('/d/fifo-a');
  });

  it('skips unlink when existsSync returns false', async () => {
    openSyncMock.mockReturnValue(5);
    createReadStreamMock.mockReturnValue(new FakeStream());
    existsSyncMock.mockReturnValue(false);

    const s = new FifoStreamer({ fifoDir: '/d', agentId: 'a' });
    s.start(() => undefined);
    await s.stop();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  it('is idempotent — a second stop() after first does nothing extra', async () => {
    openSyncMock.mockReturnValue(5);
    createReadStreamMock.mockReturnValue(new FakeStream());
    existsSyncMock.mockReturnValue(true);

    const s = new FifoStreamer({ fifoDir: '/d', agentId: 'a' });
    s.start(() => undefined);
    await s.stop();
    await s.stop();
    expect(closeSyncMock).toHaveBeenCalledTimes(1);
  });

  it('swallows close/unlink errors (best-effort cleanup)', async () => {
    openSyncMock.mockReturnValue(5);
    createReadStreamMock.mockReturnValue(new FakeStream());
    existsSyncMock.mockReturnValue(true);
    closeSyncMock.mockImplementationOnce(() => {
      throw new Error('bad fd');
    });
    unlinkSyncMock.mockImplementationOnce(() => {
      throw new Error('gone');
    });
    const s = new FifoStreamer({ fifoDir: '/d', agentId: 'a' });
    s.start(() => undefined);
    await expect(s.stop()).resolves.toBeUndefined();
  });

  it('stop() with no prior start() is a no-op', async () => {
    const s = new FifoStreamer({ fifoDir: '/d', agentId: 'a' });
    await expect(s.stop()).resolves.toBeUndefined();
    expect(closeSyncMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });
});
