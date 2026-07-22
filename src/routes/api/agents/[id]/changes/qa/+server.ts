/**
 * POST /api/agents/:id/changes/qa → { html }
 *
 * Answers a user question about the agent's diff. Stateless: the diff is
 * re-derived server-side from the worktree (the phone only sends the small
 * question + prior Q/A pairs), the prompt is assembled + size-capped, and the
 * LLM's Markdown answer is rendered through the same DOMPurify pipeline the
 * plan viewer uses before it crosses the wire.
 *
 * Owner-only. CSRF is enforced by hooks.server.ts (client uses apiFetch).
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAgent, getWorktree } from '$lib/server/db/queries';
import { getAgentChanges } from '$lib/server/git/agentDiff';
import { renderPlanMarkdownToHtml } from '$lib/server/plans/agentPlans';
import { answer, isConfigured } from '$lib/server/llm';
import { buildPrompt, type QaHistoryTurn, type QaSectionKind } from '$lib/server/llm/prompt';

const MAX_QUESTION_LEN = 4000;
const MAX_HISTORY_TURNS = 12;

interface QaRequestBody {
  question?: unknown;
  sections?: unknown;
  history?: unknown;
}

export interface QaResponse {
  /** Sanitized HTML for `{@html}`. */
  html: string;
  /** Raw Markdown answer — the client threads this back as history on follow-ups. */
  markdown: string;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const agent = getAgent(params.id);
  if (!agent) throw error(404, 'Agent not found');
  if (agent.user_id !== locals.user.id) throw error(403, 'Forbidden');

  const wt = getWorktree(agent.worktree_id);
  if (!wt) throw error(404, 'Worktree not found');

  if (!isConfigured()) return json({ code: 'ai_unconfigured' }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as QaRequestBody;
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > MAX_QUESTION_LEN) {
    return json({ code: 'invalid_question' }, { status: 400 });
  }

  const sections = normalizeSections(body.sections);
  const history = normalizeHistory(body.history);

  const changes = await getAgentChanges(wt.path, agent.base_sha);
  const prompt = buildPrompt({
    committed: changes.committed,
    uncommitted: changes.uncommitted,
    sections,
    history,
    question
  });

  let markdown: string;
  try {
    markdown = await answer(prompt);
  } catch (err) {
    return json(
      { code: 'llm_error', message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }

  return json({ html: renderPlanMarkdownToHtml(markdown), markdown } satisfies QaResponse);
};

function normalizeSections(raw: unknown): QaSectionKind[] {
  const valid: QaSectionKind[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if ((v === 'committed' || v === 'uncommitted') && !valid.includes(v)) valid.push(v);
    }
  }
  // Default to both when the client sends nothing usable.
  return valid.length > 0 ? valid : ['committed', 'uncommitted'];
}

function normalizeHistory(raw: unknown): QaHistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: QaHistoryTurn[] = [];
  for (const t of raw.slice(-MAX_HISTORY_TURNS)) {
    if (t && typeof t === 'object') {
      const q = (t as Record<string, unknown>).q;
      const a = (t as Record<string, unknown>).a;
      if (typeof q === 'string' && typeof a === 'string') turns.push({ q, a });
    }
  }
  return turns;
}
