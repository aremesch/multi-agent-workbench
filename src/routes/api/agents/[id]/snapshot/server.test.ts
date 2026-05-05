import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAgentMock = vi.fn();
const hasSessionMock = vi.fn();
const capturePaneMock = vi.fn();
const getSupervisorMock = vi.fn();
const isBrowserKindMock = vi.fn();

vi.mock('$lib/server/db/queries', () => ({
  getAgent: (id: string) => getAgentMock(id)
}));

vi.mock('$lib/server/tmux/TmuxSession', () => ({
  Tmux: {
    hasSession: (s: string) => hasSessionMock(s),
    capturePane: (s: string, n: number) => capturePaneMock(s, n)
  }
}));

vi.mock('$lib/server/bootstrap', () => ({
  getSupervisor: () => getSupervisorMock()
}));

vi.mock('$lib/server/agents/AgentSupervisor', () => ({
  isBrowserKind: (k: string) => isBrowserKindMock(k)
}));

import { GET } from './+server.js';

interface CallOpts {
  user?: { id: string } | null;
}

async function call(opts: CallOpts = {}): Promise<Response> {
  const event = {
    locals: { user: opts.user === undefined ? { id: 'user-1' } : opts.user },
    params: { id: 'agent-1' }
  };
  return GET(event as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
  getAgentMock.mockReset();
  hasSessionMock.mockReset();
  capturePaneMock.mockReset();
  getSupervisorMock.mockReset();
  isBrowserKindMock.mockReset();
  isBrowserKindMock.mockReturnValue(false);
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

describe('GET /api/agents/:id/snapshot', () => {
  it('401 when not signed in', async () => {
    await expectHttpError(call({ user: null }), 401);
  });

  it('404 when agent does not exist', async () => {
    getAgentMock.mockReturnValue(undefined);
    await expectHttpError(call(), 404);
  });

  it('403 when agent belongs to another user', async () => {
    getAgentMock.mockReturnValue({
      id: 'agent-1',
      user_id: 'other',
      cli_kind: 'shell',
      tmux_session: 'tmuxsess',
      status: 'running'
    });
    await expectHttpError(call(), 403);
  });

  it('200 alive=true with empty text for browser agents (no tmux pane)', async () => {
    isBrowserKindMock.mockReturnValue(true);
    getAgentMock.mockReturnValue({
      id: 'agent-1',
      user_id: 'user-1',
      cli_kind: 'browser',
      tmux_session: '',
      status: 'running'
    });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alive).toBe(true);
    expect(body.text).toBe('');
    expect(typeof body.ts).toBe('number');
    expect(hasSessionMock).not.toHaveBeenCalled();
  });

  it('410 with alive=false when tmux session is gone, and reaps the agent', async () => {
    getAgentMock.mockReturnValue({
      id: 'agent-1',
      user_id: 'user-1',
      cli_kind: 'shell',
      tmux_session: 'tmux-sess',
      status: 'running'
    });
    hasSessionMock.mockResolvedValue(false);
    const reapAgentMock = vi.fn().mockResolvedValue(undefined);
    getSupervisorMock.mockReturnValue({ reapAgent: reapAgentMock });
    const res = await call();
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.alive).toBe(false);
    expect(body.text).toBe('');
    expect(reapAgentMock).toHaveBeenCalledWith('agent-1');
  });

  it('410 even when reapAgent throws (logs and proceeds)', async () => {
    getAgentMock.mockReturnValue({
      id: 'agent-1',
      user_id: 'user-1',
      cli_kind: 'shell',
      tmux_session: 'tmux-sess',
      status: 'running'
    });
    hasSessionMock.mockResolvedValue(false);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getSupervisorMock.mockReturnValue({
      reapAgent: vi.fn().mockRejectedValue(new Error('reap failed'))
    });
    const res = await call();
    expect(res.status).toBe(410);
    consoleErrorSpy.mockRestore();
  });

  it('200 with captured pane text when alive', async () => {
    getAgentMock.mockReturnValue({
      id: 'agent-1',
      user_id: 'user-1',
      cli_kind: 'shell',
      tmux_session: 'tmux-sess',
      status: 'running'
    });
    hasSessionMock.mockResolvedValue(true);
    capturePaneMock.mockResolvedValue('\x1b[31mhello\x1b[0m');
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alive).toBe(true);
    expect(body.text).toBe('\x1b[31mhello\x1b[0m');
    expect(capturePaneMock).toHaveBeenCalledWith('tmux-sess', 0);
  });
});
