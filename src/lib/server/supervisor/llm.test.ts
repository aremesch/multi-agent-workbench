/**
 * Bounded supervisor LLM client tests. No network: `fetchImpl` is injected and
 * returns canned Anthropic Messages responses. We assert request shaping
 * (forced tool_choice), structured-output validation (zod), usage extraction,
 * and the retry-once-on-5xx behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import { LlmError, qcVerdict, splitPlan, type FetchLike } from './llm.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function toolResponse(name: string, input: unknown, usage = { input_tokens: 10, output_tokens: 20 }): Response {
  return jsonResponse({ content: [{ type: 'tool_use', name, input }], usage });
}

const BASE = { apiKey: 'sk-test', model: 'claude-opus-4-8' };

describe('splitPlan', () => {
  it('forces the plan tool and returns validated tasks + usage', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return toolResponse('emit_task_plan', {
        tasks: [
          { title: 'Task A', body: 'do A' },
          { title: 'Task B', body: 'do B', depends_on: [0] }
        ]
      });
    };
    const { result, usage } = await splitPlan({ ...BASE, fetchImpl, planMd: 'Build a thing' });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[1]?.depends_on).toEqual([0]);
    expect(usage).toEqual({ tokensIn: 10, tokensOut: 20 });

    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'emit_task_plan' });
    expect(sent.model).toBe('claude-opus-4-8');
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
  });

  it('weaves project-memory lessons into the user content', async () => {
    let captured = '';
    const fetchImpl: FetchLike = async (_url, init) => {
      const sent = JSON.parse(init.body as string);
      captured = sent.messages[0].content;
      return toolResponse('emit_task_plan', { tasks: [{ title: 'T', body: 'b' }] });
    };
    await splitPlan({ ...BASE, fetchImpl, planMd: 'plan', lessons: ['always run pnpm test'] });
    expect(captured).toContain('always run pnpm test');
  });

  it('rejects malformed model output with a validation error', async () => {
    const fetchImpl: FetchLike = async () => toolResponse('emit_task_plan', { tasks: [] });
    await expect(splitPlan({ ...BASE, fetchImpl, planMd: 'p' })).rejects.toMatchObject({
      kind: 'validation'
    });
  });

  it('throws a config error when the api key is missing', async () => {
    const fetchImpl: FetchLike = async () => toolResponse('emit_task_plan', { tasks: [] });
    await expect(splitPlan({ ...BASE, apiKey: '', fetchImpl, planMd: 'p' })).rejects.toBeInstanceOf(
      LlmError
    );
  });

  it('retries once on a 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
      .mockResolvedValueOnce(toolResponse('emit_task_plan', { tasks: [{ title: 'T', body: 'b' }] }));
    const { result } = await splitPlan({ ...BASE, fetchImpl, planMd: 'p' });
    expect(result.tasks).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('qcVerdict', () => {
  it('returns a structured pass verdict', async () => {
    const fetchImpl: FetchLike = async () =>
      toolResponse('emit_qc_verdict', { verdict: 'pass', summary: 'looks good', issues: [] });
    const { result } = await qcVerdict({
      ...BASE,
      fetchImpl,
      taskTitle: 'T',
      taskBody: 'b',
      diff: 'diff --git ...'
    });
    expect(result.verdict).toBe('pass');
    expect(result.issues).toEqual([]);
  });

  it('returns issues on a fail verdict', async () => {
    const fetchImpl: FetchLike = async () =>
      toolResponse('emit_qc_verdict', {
        verdict: 'fail',
        summary: 'needs work',
        issues: [{ category: 'dry', severity: 'high', detail: 'duplicated helper' }]
      });
    const { result } = await qcVerdict({
      ...BASE,
      fetchImpl,
      taskTitle: 'T',
      taskBody: 'b',
      diff: 'd'
    });
    expect(result.verdict).toBe('fail');
    expect(result.issues[0]?.category).toBe('dry');
  });

  it('throws shape error when the tool call is absent', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ content: [{ type: 'text', text: 'hi' }] });
    await expect(
      qcVerdict({ ...BASE, fetchImpl, taskTitle: 'T', taskBody: 'b', diff: 'd' })
    ).rejects.toMatchObject({ kind: 'shape' });
  });
});
