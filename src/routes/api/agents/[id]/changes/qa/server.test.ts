/**
 * Unit tests for the POST /api/agents/:id/changes/qa route.
 *
 * Mocks the DB, git helper, LLM facade, prompt builder, and markdown renderer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAgentMock = vi.fn();
const getWorktreeMock = vi.fn();
const getAgentChangesMock = vi.fn();
const isConfiguredMock = vi.fn();
const answerMock = vi.fn();
const buildPromptMock = vi.fn();
const renderMock = vi.fn();

vi.mock('$lib/server/db/queries', () => ({
  getAgent: (id: string) => getAgentMock(id),
  getWorktree: (id: string) => getWorktreeMock(id)
}));
vi.mock('$lib/server/git/agentDiff', () => ({
  getAgentChanges: (...a: unknown[]) => getAgentChangesMock(...a)
}));
vi.mock('$lib/server/llm', () => ({
  isConfigured: () => isConfiguredMock(),
  answer: (...a: unknown[]) => answerMock(...a)
}));
vi.mock('$lib/server/llm/prompt', () => ({
  buildPrompt: (...a: unknown[]) => buildPromptMock(...a)
}));
vi.mock('$lib/server/plans/agentPlans', () => ({
  renderPlanMarkdownToHtml: (md: string) => renderMock(md)
}));

import { POST } from './+server.js';

interface CallOpts {
  agentId?: string;
  user?: { id: string } | null;
  body?: unknown;
}

async function call(opts: CallOpts = {}): Promise<Response> {
  const id = opts.agentId ?? 'agent-1';
  const event = {
    locals: { user: opts.user === undefined ? { id: 'user-1' } : opts.user },
    params: { id },
    request: {
      json: async () => opts.body ?? { question: 'why?' }
    }
  };
  return POST(event as unknown as Parameters<typeof POST>[0]);
}

async function expectHttpError(res: Promise<unknown>, status: number): Promise<void> {
  let caught: unknown = null;
  try {
    await res;
  } catch (err) {
    caught = err;
  }
  expect((caught as { status?: number })?.status).toBe(status);
}

beforeEach(() => {
  for (const m of [
    getAgentMock,
    getWorktreeMock,
    getAgentChangesMock,
    isConfiguredMock,
    answerMock,
    buildPromptMock,
    renderMock
  ]) {
    m.mockReset();
  }
  getAgentMock.mockReturnValue({
    id: 'agent-1',
    user_id: 'user-1',
    worktree_id: 'wt-1',
    base_sha: 'BASE'
  });
  getWorktreeMock.mockReturnValue({ id: 'wt-1', path: '/wt' });
  getAgentChangesMock.mockResolvedValue({
    committed: { files: [] },
    uncommitted: { files: [] }
  });
  buildPromptMock.mockReturnValue({ system: 'sys', user: 'usr' });
});
afterEach(() => vi.clearAllMocks());

describe('POST /changes/qa — auth', () => {
  it('401 when not signed in', async () => {
    isConfiguredMock.mockReturnValue(true);
    await expectHttpError(call({ user: null }), 401);
  });
  it('404 when the agent is missing', async () => {
    getAgentMock.mockReturnValue(undefined);
    isConfiguredMock.mockReturnValue(true);
    await expectHttpError(call(), 404);
  });
  it('403 for another user’s agent', async () => {
    getAgentMock.mockReturnValue({ id: 'agent-1', user_id: 'other', worktree_id: 'wt-1' });
    isConfiguredMock.mockReturnValue(true);
    await expectHttpError(call(), 403);
  });
});

describe('POST /changes/qa — behaviour', () => {
  it('503 ai_unconfigured when no credential is set', async () => {
    isConfiguredMock.mockReturnValue(false);
    const res = await call();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('ai_unconfigured');
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('400 invalid_question when the question is empty', async () => {
    isConfiguredMock.mockReturnValue(true);
    const res = await call({ body: { question: '   ' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_question');
  });

  it('502 llm_error when the model call throws', async () => {
    isConfiguredMock.mockReturnValue(true);
    answerMock.mockRejectedValue(new Error('boom'));
    const res = await call({ body: { question: 'why?' } });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('llm_error');
  });

  it('returns sanitized html + markdown on success', async () => {
    isConfiguredMock.mockReturnValue(true);
    answerMock.mockResolvedValue('**hi**');
    renderMock.mockReturnValue('<strong>hi</strong>');
    const res = await call({ body: { question: 'explain', sections: ['committed'] } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ html: '<strong>hi</strong>', markdown: '**hi**' });
    expect(renderMock).toHaveBeenCalledWith('**hi**');
    // Prompt built from the re-derived diff, forwarding the requested section.
    expect(buildPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ sections: ['committed'], question: 'explain' })
    );
  });
});
