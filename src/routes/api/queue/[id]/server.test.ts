import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntryRow, QueueEntryStatus } from '$lib/server/db/types';

const verifyCsrfMock = vi.fn();
const getQueueEntryForUserMock = vi.fn();
const listQueueEntriesByIdsMock = vi.fn();
const updateQueueEntryFieldsMock = vi.fn();
const isSlugInUseMock = vi.fn();
const scheduleTickMock = vi.fn();
const coerceQueueInputMock = vi.fn();
const validateQueueInputMock = vi.fn();

vi.mock('$lib/server/auth/csrf', () => ({
  verifyCsrf: (event: unknown) => verifyCsrfMock(event)
}));
vi.mock('$lib/server/config', () => ({
  getConfig: () => ({ worktreeRoot: '/tmp/wtroot' })
}));
vi.mock('$lib/server/db/queries', () => ({
  getQueueEntryForUser: (...a: unknown[]) => getQueueEntryForUserMock(...a),
  isSlugInUse: (...a: unknown[]) => isSlugInUseMock(...a),
  listQueueEntriesByIds: (...a: unknown[]) => listQueueEntriesByIdsMock(...a),
  updateQueueEntryFields: (...a: unknown[]) => updateQueueEntryFieldsMock(...a)
}));
vi.mock('$lib/server/bootstrap', () => ({
  getScheduler: () => ({ scheduleTick: scheduleTickMock })
}));
vi.mock('../_payload', () => ({
  coerceQueueInput: (...a: unknown[]) => coerceQueueInputMock(...a),
  validateQueueInput: (...a: unknown[]) => validateQueueInputMock(...a)
}));

import { PUT } from './+server.js';

function makeRow(overrides: Partial<QueueEntryRow> = {}): QueueEntryRow {
  return {
    id: 'q1',
    user_id: 'user-1',
    role_id: 'role-1',
    repo_id: 'repo-1',
    title: 'Old title',
    body: 'old body',
    target_url: null,
    model: null,
    permission_mode: null,
    source_branch: 'main',
    with_worktree: 1,
    optional_args_json: '{}',
    priority: 0,
    depends_on_json: '[]',
    scheduled_for: null,
    exclusive: 0,
    queued: 0,
    plan_md: null,
    plan_source_path: null,
    status: 'pending',
    agent_id: null,
    external_source_json: null,
    attachments_json: '[]',
    last_error: null,
    created_at: 1,
    updated_at: 1,
    started_at: null,
    completed_at: null,
    ...overrides
  };
}

/** A coerced QueueInput shape (only the fields the PUT handler reads). */
function coerced(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    value: {
      roleId: 'role-1',
      repoId: 'repo-1',
      taskTitle: 'New title',
      taskBody: 'new body',
      targetUrl: '',
      branch: 'main',
      withWorktreeExplicit: true,
      model: null,
      permissionMode: null,
      optionalArgs: { fast: true },
      priority: 5,
      dependsOn: [],
      scheduledFor: null,
      exclusive: false,
      queued: true,
      planMd: 'plan',
      planSourcePath: null,
      ...overrides
    }
  };
}

/** A validated spawn-inputs shape (only the fields the PUT handler reads). */
function validated(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    value: {
      role: { id: 'role-1' },
      title: 'New title',
      slug: 'new-title',
      adapter: { initialInputDelivery: 'cli-arg' },
      browser: null,
      model: null,
      permissionMode: null,
      adapterSupportsWorktree: true,
      branchStartPoint: 'main',
      shouldCreateWorktree: true,
      ...overrides
    }
  };
}

interface CallOpts {
  user?: { id: string } | null;
  id?: string;
  body?: unknown;
  rawBody?: string;
  csrfThrows?: boolean;
}

async function call(opts: CallOpts = {}): Promise<Response> {
  if (opts.csrfThrows) {
    verifyCsrfMock.mockImplementationOnce(() => {
      throw { status: 403, body: { message: 'csrf' } };
    });
  }
  const bodyStr =
    opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  const request = new Request('http://localhost/api/queue/q1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: bodyStr
  });
  const event = {
    locals: {
      user: opts.user === undefined ? { id: 'user-1' } : opts.user,
      locale: 'en',
      supervisor: { registry: {} }
    },
    params: { id: opts.id ?? 'q1' },
    request,
    cookies: { get: () => undefined }
  };
  return PUT(event as unknown as Parameters<typeof PUT>[0]);
}

beforeEach(() => {
  verifyCsrfMock.mockReset();
  getQueueEntryForUserMock.mockReset().mockReturnValue(makeRow());
  listQueueEntriesByIdsMock.mockReset().mockReturnValue([]);
  updateQueueEntryFieldsMock.mockReset().mockReturnValue(true);
  isSlugInUseMock.mockReset().mockReturnValue(false);
  scheduleTickMock.mockReset();
  coerceQueueInputMock.mockReset().mockReturnValue(coerced());
  validateQueueInputMock.mockReset().mockResolvedValue(validated());
});
afterEach(() => {
  vi.clearAllMocks();
});

async function expectThrowStatus(res: Promise<unknown>, status: number): Promise<void> {
  let caught: unknown = null;
  try {
    await res;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected handler to throw').not.toBeNull();
  expect((caught as { status?: number }).status).toBe(status);
}

describe('PUT /api/queue/:id', () => {
  it('throws 403 when CSRF fails', async () => {
    await expectThrowStatus(call({ csrfThrows: true }), 403);
  });

  it('401 when not signed in', async () => {
    const res = await call({ user: null });
    expect(res.status).toBe(401);
  });

  it('404 when the entry is missing or foreign', async () => {
    getQueueEntryForUserMock.mockReturnValue(undefined);
    const res = await call();
    expect(res.status).toBe(404);
  });

  it.each<QueueEntryStatus>(['running', 'done', 'failed', 'cancelled'])(
    '409 when the entry is %s (no longer editable)',
    async (status) => {
      getQueueEntryForUserMock.mockReturnValue(makeRow({ status }));
      const res = await call();
      expect(res.status).toBe(409);
      expect(updateQueueEntryFieldsMock).not.toHaveBeenCalled();
    }
  );

  it('400 when the body is not valid JSON', async () => {
    const res = await call({ rawBody: '{' });
    expect(res.status).toBe(400);
  });

  it('400 when coercion fails', async () => {
    coerceQueueInputMock.mockReturnValue({
      ok: false,
      errorKey: 'spawn.error.titleRequired'
    });
    const res = await call();
    expect(res.status).toBe(400);
  });

  it('400 when the entry depends on itself', async () => {
    coerceQueueInputMock.mockReturnValue(coerced({ dependsOn: ['q1'] }));
    const res = await call({ id: 'q1' });
    expect(res.status).toBe(400);
  });

  it('400 when a dependency is unknown', async () => {
    coerceQueueInputMock.mockReturnValue(coerced({ dependsOn: ['dep-1', 'dep-2'] }));
    listQueueEntriesByIdsMock.mockReturnValue([{ id: 'dep-1' }]); // only 1 of 2
    const res = await call();
    expect(res.status).toBe(400);
  });

  it('400 when validation fails', async () => {
    validateQueueInputMock.mockResolvedValue({
      ok: false,
      errorKey: 'spawn.error.unknownRole'
    });
    const res = await call();
    expect(res.status).toBe(400);
  });

  it('200 on success: maps validated fields and re-ticks the scheduler', async () => {
    coerceQueueInputMock.mockReturnValue(
      coerced({ priority: 7, optionalArgs: { fast: true }, planMd: 'the plan' })
    );
    validateQueueInputMock.mockResolvedValue(
      validated({
        role: { id: 'role-9' },
        title: 'Edited title',
        adapter: { initialInputDelivery: 'cli-arg' },
        model: 'opus',
        shouldCreateWorktree: false,
        adapterSupportsWorktree: true,
        branchStartPoint: 'dev'
      })
    );

    const res = await call();
    expect(res.status).toBe(200);

    expect(updateQueueEntryFieldsMock).toHaveBeenCalledTimes(1);
    const [id, patch] = updateQueueEntryFieldsMock.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(id).toBe('q1');
    expect(patch).toMatchObject({
      role_id: 'role-9',
      title: 'Edited title',
      body: 'new body', // cli-arg adapter keeps the body
      model: 'opus',
      priority: 7,
      with_worktree: false,
      source_branch: 'dev',
      plan_md: 'the plan'
    });
    expect(patch.optional_args_json).toBe(JSON.stringify({ fast: true }));
    // queued bit is intentionally NOT part of the edit patch.
    expect(patch).not.toHaveProperty('queued');
    expect(scheduleTickMock).toHaveBeenCalledTimes(1);
  });

  it('409 when the new title collides with another active entry’s slug', async () => {
    isSlugInUseMock.mockReturnValue(true);
    const res = await call();
    expect(res.status).toBe(409);
    expect(updateQueueEntryFieldsMock).not.toHaveBeenCalled();
  });

  it('passes the row id to isSlugInUse so an unchanged self-edit is allowed', async () => {
    isSlugInUseMock.mockReturnValue(false);
    const res = await call({ id: 'q1' });
    expect(res.status).toBe(200);
    expect(isSlugInUseMock).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      '/tmp/wtroot',
      'q1'
    );
  });

  it('nulls the body for adapters without cli-arg input delivery', async () => {
    validateQueueInputMock.mockResolvedValue(
      validated({ adapter: { initialInputDelivery: 'none' } })
    );
    const res = await call();
    expect(res.status).toBe(200);
    const [, patch] = updateQueueEntryFieldsMock.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(patch.body).toBeNull();
  });
});
