import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAgentMock = vi.fn();
const listAllTerminalChunksMock = vi.fn();

vi.mock('$lib/server/db/queries', () => ({
  getAgent: (id: string) => getAgentMock(id),
  listAllTerminalChunks: (id: string) => listAllTerminalChunksMock(id)
}));

import { GET } from './+server.js';

interface CallOpts {
  user?: { id: string } | null;
  agentId?: string;
}

async function call(opts: CallOpts = {}): Promise<Response> {
  const id = opts.agentId ?? 'agent-1';
  const event = {
    locals: { user: opts.user === undefined ? { id: 'user-1' } : opts.user },
    params: { id }
  };
  return GET(event as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
  getAgentMock.mockReset();
  listAllTerminalChunksMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

async function expectHttpError(res: Promise<unknown>, status: number): Promise<void> {
  let caught: unknown = null;
  try {
    await res;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected handler to throw').not.toBeNull();
  expect((caught as { status?: number }).status).toBe(status);
}

describe('GET /api/agents/:id/log', () => {
  it('401 when not signed in', async () => {
    await expectHttpError(call({ user: null }), 401);
  });

  it('404 when agent does not exist', async () => {
    getAgentMock.mockReturnValue(undefined);
    await expectHttpError(call(), 404);
  });

  it('403 when agent belongs to another user', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'other' });
    await expectHttpError(call(), 403);
  });

  it('200 with empty buffer when no chunks exist', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1' });
    listAllTerminalChunksMock.mockReturnValue([]);
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(0);
  });

  it('200 with concatenated chunks in order', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1' });
    listAllTerminalChunksMock.mockReturnValue([
      { chunk: Buffer.from('hello ') },
      { chunk: Buffer.from('world') }
    ]);
    const res = await call();
    expect(res.status).toBe(200);
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    expect(text).toBe('hello world');
  });
});
