/**
 * Unit tests for /api/queue/:id/attachments (POST + GET).
 *
 * DB, CSRF and the staging helper are mocked so the test is pure Node.
 * Mirrors src/routes/api/agents/[id]/upload-image/server.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCsrfMock = vi.fn();
const getEntryMock = vi.fn();
const setAttachmentsMock = vi.fn();
const validateUploadMock = vi.fn();
const stageMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (e: unknown) => verifyCsrfMock(e)
}));
vi.mock('$lib/server/db/queries', () => ({
  getQueueEntryForUser: (...a: unknown[]) => getEntryMock(...a),
  setQueueEntryAttachments: (...a: unknown[]) => setAttachmentsMock(...a)
}));
vi.mock('$lib/server/uploads/imageUploadCore', () => ({
  MAX_BYTES: 5 * 1024 * 1024,
  validateUpload: (...a: unknown[]) => validateUploadMock(...a)
}));
vi.mock('$lib/server/uploads/taskAttachmentUploads', () => ({
  MAX_TASK_ATTACHMENTS: 10,
  stageTaskAttachment: (...a: unknown[]) => stageMock(...a),
  parseAttachments: (json: string) => (json ? JSON.parse(json) : []),
  serializeAttachments: (r: unknown) => JSON.stringify(r),
  publicAttachments: (r: Array<Record<string, unknown>>) =>
    r.map((x) => ({ filename: x.filename, mime: x.mime, size: x.size }))
}));

import { GET, POST } from './+server.js';

function pngFile(): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 's.png', {
    type: 'image/png'
  });
}

interface Opts {
  user?: { id: string } | null;
  entry?: Record<string, unknown> | undefined;
  formData?: FormData | null;
  csrfThrows?: boolean;
}

function postCall(opts: Opts = {}): Promise<Response> {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  const fd = opts.formData === undefined ? new FormData() : opts.formData;
  const request = new Request('http://localhost/api/queue/q1/attachments', {
    method: 'POST',
    body: fd ?? undefined
  });
  const event = {
    locals: { user: opts.user === undefined ? { id: 'u1' } : opts.user },
    params: { id: 'q1' },
    request,
    cookies: { get: () => undefined }
  };
  return Promise.resolve(POST(event as unknown as Parameters<typeof POST>[0]));
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  getEntryMock.mockReset();
  setAttachmentsMock.mockReset().mockReturnValue(true);
  validateUploadMock.mockReset();
  stageMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

async function expectThrow(res: Promise<unknown>, status: number): Promise<void> {
  let caught: unknown = null;
  try {
    await res;
  } catch (e) {
    caught = e;
  }
  expect(caught).not.toBeNull();
  expect((caught as { status?: number }).status).toBe(status);
}

describe('POST /api/queue/:id/attachments — guards', () => {
  it('403 when CSRF fails', async () => {
    await expectThrow(postCall({ csrfThrows: true }), 403);
  });
  it('401 when signed out', async () => {
    await expectThrow(postCall({ user: null }), 401);
  });
  it('404 when the task is missing', async () => {
    getEntryMock.mockReturnValue(undefined);
    await expectThrow(postCall(), 404);
  });
  it('409 when the task is frozen (running/terminal)', async () => {
    getEntryMock.mockReturnValue({ status: 'running', attachments_json: '[]' });
    const res = await postCall();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'frozen' });
  });
});

describe('POST /api/queue/:id/attachments — validation + success', () => {
  beforeEach(() => {
    getEntryMock.mockReturnValue({ status: 'pending', attachments_json: '[]' });
  });

  it('400 no_file when no file field', async () => {
    const res = await postCall();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'no_file' });
  });

  it('400 with the validator code (mime/size)', async () => {
    validateUploadMock.mockReturnValue({ ok: false, code: 'mime' });
    const fd = new FormData();
    fd.set('file', pngFile());
    const res = await postCall({ formData: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'mime' });
  });

  it('400 too_many at the per-task cap', async () => {
    const list = Array.from({ length: 10 }, (_, i) => ({
      filename: `f${i}.png`,
      mime: 'image/png',
      size: 1,
      stagedPath: `/x/f${i}.png`
    }));
    getEntryMock.mockReturnValue({
      status: 'pending',
      attachments_json: JSON.stringify(list)
    });
    validateUploadMock.mockReturnValue({ ok: true, ext: 'png' });
    const fd = new FormData();
    fd.set('file', pngFile());
    const res = await postCall({ formData: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'too_many' });
  });

  it('stages the file and persists the new list', async () => {
    validateUploadMock.mockReturnValue({ ok: true, ext: 'png' });
    stageMock.mockResolvedValue({
      filename: 'g-1.png',
      mime: 'image/png',
      size: 4,
      stagedPath: '/x/g-1.png'
    });
    const fd = new FormData();
    fd.set('file', pngFile());
    const res = await postCall({ formData: fd });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      filename: 'g-1.png',
      sizeBytes: 4,
      mime: 'image/png'
    });
    expect(setAttachmentsMock).toHaveBeenCalledWith(
      'q1',
      'u1',
      JSON.stringify([
        { filename: 'g-1.png', mime: 'image/png', size: 4, stagedPath: '/x/g-1.png' }
      ])
    );
  });
});

describe('GET /api/queue/:id/attachments', () => {
  it('returns public metadata only (no stagedPath)', async () => {
    getEntryMock.mockReturnValue({
      attachments_json: JSON.stringify([
        { filename: 'a.png', mime: 'image/png', size: 9, stagedPath: '/secret/a.png' }
      ])
    });
    const event = {
      locals: { user: { id: 'u1' } },
      params: { id: 'q1' }
    };
    const res = await GET(event as unknown as Parameters<typeof GET>[0]);
    expect(await res.json()).toEqual({
      attachments: [{ filename: 'a.png', mime: 'image/png', size: 9 }]
    });
  });
});
