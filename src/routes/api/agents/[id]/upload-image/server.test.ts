/**
 * Unit tests for the POST /api/agents/:id/upload-image route.
 *
 * Mocks DB queries, CSRF, and the upload helper so the test runs in
 * pure Node — no disk or DB. Mirrors the plan-route test pattern in
 * src/routes/api/agents/[id]/plan/server.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const getAgentMock = vi.fn();
const getWorktreeMock = vi.fn();
const validateUploadMock = vi.fn();
const writeAgentImageMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));

vi.mock('$lib/server/db/queries', () => ({
  getAgent: (id: string) => getAgentMock(id),
  getWorktree: (id: string) => getWorktreeMock(id)
}));

vi.mock('$lib/server/uploads/agentImageUploads', () => ({
  MAX_BYTES: 5 * 1024 * 1024,
  validateUpload: (...args: unknown[]) => validateUploadMock(...args),
  writeAgentImage: (...args: unknown[]) => writeAgentImageMock(...args)
}));

import { POST } from './+server.js';

interface CallOpts {
  agentId?: string;
  user?: { id: string } | null;
  formData?: FormData | null;
  csrfThrows?: boolean;
}

function makeFormData(file: File | null): FormData {
  const fd = new FormData();
  if (file) fd.set('file', file);
  return fd;
}

async function call(opts: CallOpts = {}): Promise<Response> {
  const id = opts.agentId ?? 'agent-1';
  const fd = opts.formData === undefined ? makeFormData(null) : opts.formData;

  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      const e: { status: number; body: { message: string } } = {
        status: 403,
        body: { message: 'csrf' }
      };
      throw e;
    });
  }

  const request = new Request(`http://localhost/api/agents/${id}/upload-image`, {
    method: 'POST',
    body: fd ?? undefined
  });

  const event = {
    locals: { user: opts.user === undefined ? { id: 'user-1' } : opts.user },
    params: { id },
    request,
    cookies: { get: () => undefined }
  };
  return POST(event as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  getAgentMock.mockReset();
  getWorktreeMock.mockReset();
  validateUploadMock.mockReset();
  writeAgentImageMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

async function expectHttpError(
  res: Promise<unknown>,
  status: number
): Promise<{ status: number; body?: { message?: string } }> {
  let caught: unknown = null;
  try {
    await res;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected handler to throw').not.toBeNull();
  const e = caught as { status?: number; body?: { message?: string } };
  expect(e.status).toBe(status);
  return e as { status: number; body?: { message?: string } };
}

describe('POST /api/agents/:id/upload-image — guards', () => {
  it('403 when CSRF verification fails', async () => {
    await expectHttpError(call({ csrfThrows: true }), 403);
  });

  it('401 when not signed in', async () => {
    await expectHttpError(call({ user: null }), 401);
  });

  it('404 when the agent does not exist', async () => {
    getAgentMock.mockReturnValue(undefined);
    await expectHttpError(call(), 404);
  });

  it('403 when the agent belongs to another user', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'other-user', worktree_id: 'wt-1' });
    await expectHttpError(call(), 403);
  });

  it('404 when the worktree row is missing', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1', worktree_id: 'wt-1' });
    getWorktreeMock.mockReturnValue(undefined);
    await expectHttpError(call(), 404);
  });
});

describe('POST /api/agents/:id/upload-image — multipart parsing', () => {
  beforeEach(() => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1', worktree_id: 'wt-1' });
    getWorktreeMock.mockReturnValue({ id: 'wt-1', path: '/wt' });
  });

  it('400 no_file when the form has no `file` field', async () => {
    const res = await call({ formData: makeFormData(null) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'no_file' });
  });

  it('400 no_file when the request body is not multipart at all', async () => {
    const request = new Request('http://localhost/api/agents/agent-1/upload-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"foo":"bar"}'
    });
    const event = {
      locals: { user: { id: 'user-1' } },
      params: { id: 'agent-1' },
      request,
      cookies: { get: () => undefined }
    };
    const res = await POST(event as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'no_file' });
  });
});

describe('POST /api/agents/:id/upload-image — validation', () => {
  beforeEach(() => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1', worktree_id: 'wt-1' });
    getWorktreeMock.mockReturnValue({ id: 'wt-1', path: '/wt' });
  });

  it('400 mime when MIME is rejected', async () => {
    validateUploadMock.mockReturnValue({ ok: false, code: 'mime' });
    const file = new File([new Uint8Array([0])], 'x.svg', { type: 'image/svg+xml' });
    const res = await call({ formData: makeFormData(file) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('mime');
  });

  it('400 size when oversized', async () => {
    validateUploadMock.mockReturnValue({ ok: false, code: 'size' });
    const file = new File([new Uint8Array([0])], 'x.png', { type: 'image/png' });
    const res = await call({ formData: makeFormData(file) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('size');
    expect(body.maxBytes).toBe(5 * 1024 * 1024);
  });

  it('passes the multipart MIME and size into validateUpload', async () => {
    validateUploadMock.mockReturnValue({ ok: false, code: 'mime' });
    const bytes = new Uint8Array([1, 2, 3]);
    const file = new File([bytes], 'x.png', { type: 'image/png' });
    await call({ formData: makeFormData(file) });
    expect(validateUploadMock).toHaveBeenCalledWith('image/png', bytes.byteLength);
  });
});

describe('POST /api/agents/:id/upload-image — happy path', () => {
  beforeEach(() => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'user-1', worktree_id: 'wt-1' });
    getWorktreeMock.mockReturnValue({ id: 'wt-1', path: '/wt' });
    validateUploadMock.mockReturnValue({ ok: true, ext: 'png' });
    writeAgentImageMock.mockResolvedValue({
      relativePath: '.maw/uploads/abc-123def.png',
      absolutePath: '/wt/.maw/uploads/abc-123def.png',
      filename: 'abc-123def.png'
    });
  });

  it('200 with relativePath, filename, sizeBytes, mime', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    const file = new File([bytes], 'screenshot.png', { type: 'image/png' });
    const res = await call({ formData: makeFormData(file) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.relativePath).toBe('.maw/uploads/abc-123def.png');
    expect(body.filename).toBe('abc-123def.png');
    expect(body.sizeBytes).toBe(bytes.byteLength);
    expect(body.mime).toBe('image/png');
  });

  it('forwards worktree path, MIME, and bytes into writeAgentImage', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = new File([bytes], 'x.png', { type: 'image/png' });
    await call({ formData: makeFormData(file) });

    expect(writeAgentImageMock).toHaveBeenCalledTimes(1);
    const callArgs = writeAgentImageMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('/wt');
    expect(callArgs[1]).toBe('image/png');
    expect(Array.from(callArgs[2] as Uint8Array)).toEqual(Array.from(bytes));
  });
});
