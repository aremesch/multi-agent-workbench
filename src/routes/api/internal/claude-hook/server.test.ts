/**
 * Unit tests for the claude-hook receiver route. The route depends on
 * `getAgentByHookToken` and `getSupervisor()`; both are mocked here so
 * the test runs in pure-Node with no DB or live runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ingestSpy = vi.fn();
const getAgentByHookTokenSpy = vi.fn();

vi.mock('$lib/server/db/queries', () => ({
  getAgentByHookToken: (token: string) => getAgentByHookTokenSpy(token)
}));

vi.mock('$lib/server/bootstrap', () => ({
  getSupervisor: () => ({
    ingestClaudeHook: (agentId: string, payload: Record<string, unknown>) => {
      ingestSpy(agentId, payload);
    }
  })
}));

import { POST } from './+server.js';

interface CallOpts {
  authHeader?: string | null;
  body?: string | null;
  bodyObj?: Record<string, unknown>;
  clientAddress?: string;
}

async function call(opts: CallOpts = {}): Promise<Response> {
  const auth = opts.authHeader === undefined ? 'Bearer tok-123' : opts.authHeader;
  const headers = new Headers();
  if (auth !== null) headers.set('authorization', auth);
  headers.set('content-type', 'application/json');
  const body =
    opts.body !== undefined
      ? opts.body
      : JSON.stringify(
          opts.bodyObj ?? {
            hook_event_name: 'PreToolUse',
            session_id: 'sess-1',
            tool_name: 'Bash',
            tool_input: { command: 'ls /tmp' },
            tool_use_id: 'tu-1'
          }
        );
  const request = new Request('http://127.0.0.1:5050/api/internal/claude-hook', {
    method: 'POST',
    headers,
    body
  });
  return POST({
    request,
    getClientAddress: () => opts.clientAddress ?? '127.0.0.1'
    // SvelteKit's RequestEvent has many other fields we don't touch; the
    // route reads only `request` + `getClientAddress`. Cast loosely so
    // we don't have to stub the rest.
  } as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  ingestSpy.mockReset();
  getAgentByHookTokenSpy.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/internal/claude-hook', () => {
  describe('loopback gate', () => {
    it('rejects non-loopback requests with 403', async () => {
      getAgentByHookTokenSpy.mockReturnValue({ id: 'agent-1' });
      const res = await call({ clientAddress: '10.0.0.5' });
      expect(res.status).toBe(403);
      expect(ingestSpy).not.toHaveBeenCalled();
    });

    it('accepts 127.0.0.1', async () => {
      getAgentByHookTokenSpy.mockReturnValue({ id: 'agent-1' });
      const res = await call({ clientAddress: '127.0.0.1' });
      expect(res.status).toBe(204);
    });

    it('accepts ::1', async () => {
      getAgentByHookTokenSpy.mockReturnValue({ id: 'agent-1' });
      const res = await call({ clientAddress: '::1' });
      expect(res.status).toBe(204);
    });

    it('accepts the IPv4-mapped form ::ffff:127.0.0.1', async () => {
      getAgentByHookTokenSpy.mockReturnValue({ id: 'agent-1' });
      const res = await call({ clientAddress: '::ffff:127.0.0.1' });
      expect(res.status).toBe(204);
    });
  });

  describe('bearer token', () => {
    it('returns 401 when the header is missing', async () => {
      const res = await call({ authHeader: null });
      expect(res.status).toBe(401);
    });

    it('returns 401 when the header is malformed', async () => {
      const res = await call({ authHeader: 'NotBearer xyz' });
      expect(res.status).toBe(401);
    });

    it('returns 401 when the token is empty', async () => {
      const res = await call({ authHeader: 'Bearer  ' });
      expect(res.status).toBe(401);
    });

    it('returns 401 when the token does not match an agent', async () => {
      getAgentByHookTokenSpy.mockReturnValue(undefined);
      const res = await call({ authHeader: 'Bearer no-such-token' });
      expect(res.status).toBe(401);
      expect(getAgentByHookTokenSpy).toHaveBeenCalledWith('no-such-token');
    });

    it('accepts a valid token', async () => {
      getAgentByHookTokenSpy.mockReturnValue({ id: 'agent-9' });
      const res = await call({ authHeader: 'Bearer good-tok' });
      expect(res.status).toBe(204);
      expect(ingestSpy).toHaveBeenCalledTimes(1);
      expect(ingestSpy).toHaveBeenCalledWith('agent-9', expect.any(Object));
    });
  });

  describe('payload handling', () => {
    beforeEach(() => {
      getAgentByHookTokenSpy.mockReturnValue({ id: 'agent-X' });
    });

    it('forwards parsed JSON to the supervisor', async () => {
      const body = {
        hook_event_name: 'Notification',
        session_id: 'sess-1',
        notification_type: 'permission_prompt',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/foo' }
      };
      await call({ bodyObj: body });
      expect(ingestSpy).toHaveBeenCalledWith('agent-X', body);
    });

    it('returns 400 on malformed JSON', async () => {
      const res = await call({ body: '{not json' });
      expect(res.status).toBe(400);
      expect(ingestSpy).not.toHaveBeenCalled();
    });

    it('returns 413 on oversized payload', async () => {
      const big = JSON.stringify({ x: 'a'.repeat(70_000) });
      const res = await call({ body: big });
      expect(res.status).toBe(413);
    });

    it('returns 204 even when ingest throws (so claude-code is not blocked)', async () => {
      ingestSpy.mockImplementation(() => {
        throw new Error('boom');
      });
      const res = await call();
      expect(res.status).toBe(204);
    });
  });
});
