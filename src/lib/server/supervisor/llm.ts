/**
 * Bounded LLM calls for the supervisor — the ONLY place the supervisor itself
 * talks to a model. Two calls, both forced to return structured tool-use output
 * validated with zod:
 *
 *   splitPlan()  — large product plan  →  ordered list of sub-tasks
 *   qcVerdict()  — git diff + QC notes →  { verdict: pass|fail, issues[] }
 *
 * Everything else the supervisor does is deterministic control flow (see
 * SupervisorEngine). Keeping the model contained here means token spend is
 * countable (callers persist `usage`) and the branching logic stays testable.
 *
 * We hit the Anthropic Messages API directly via `fetch` (no SDK dependency,
 * matching the rest of the server) and inject `fetchImpl` for unit tests.
 */

import { z } from 'zod';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface LlmCallOptions {
  apiKey: string;
  model: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Hard ceiling on output tokens for this call. */
  maxTokens?: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'http' | 'shape' | 'validation'
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

// --------------------------- schemas ---------------------------

export const PlanTaskSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  /** 0-based indices of EARLIER tasks in this list that must finish first. */
  depends_on: z.array(z.number().int().nonnegative()).optional()
});

export const PlanSplitSchema = z.object({
  tasks: z.array(PlanTaskSchema).min(1)
});

export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type PlanSplitResult = z.infer<typeof PlanSplitSchema>;

export const QcIssueSchema = z.object({
  category: z.string().min(1).max(60),
  severity: z.enum(['low', 'medium', 'high']),
  detail: z.string().min(1)
});

export const QcVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  summary: z.string().default(''),
  issues: z.array(QcIssueSchema).default([])
});

export type QcIssue = z.infer<typeof QcIssueSchema>;
export type QcVerdict = z.infer<typeof QcVerdictSchema>;

// --------------------- hand-written JSON schemas ----------------------
// (input_schema for the forced tool. Kept in lock-step with the zod schemas
//  above; zod still validates the model's response so a drift is caught.)

const PLAN_TOOL = {
  name: 'emit_task_plan',
  description: 'Return the product plan split into small, independently-executable coding tasks.',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short imperative task title.' },
            body: {
              type: 'string',
              description: 'Full task instructions for a coding agent: what to build and acceptance criteria.'
            },
            depends_on: {
              type: 'array',
              items: { type: 'integer', minimum: 0 },
              description: '0-based indices of earlier tasks that must complete before this one.'
            }
          },
          required: ['title', 'body']
        }
      }
    },
    required: ['tasks']
  }
} as const;

const QC_TOOL = {
  name: 'emit_qc_verdict',
  description: 'Return a structured quality-check verdict for the produced code change.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      summary: { type: 'string', description: 'One-paragraph summary of the assessment.' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              description: 'Issue class, e.g. dry, testing, style, security, perf, error-handling.'
            },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            detail: { type: 'string' }
          },
          required: ['category', 'severity', 'detail']
        }
      }
    },
    required: ['verdict', 'issues']
  }
} as const;

// --------------------------- core call ---------------------------

interface ToolDef {
  name: string;
  description: string;
  input_schema: unknown;
}

interface AnthropicResponse {
  content?: Array<{ type: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Make one forced-tool-use call and return the raw tool input + usage. Retries
 * ONCE on a transient HTTP failure (429/5xx). Validation/parse failures are
 * surfaced to the caller (which decides whether to re-prompt).
 */
async function callTool(
  opts: LlmCallOptions,
  system: string,
  userContent: string,
  tool: ToolDef
): Promise<{ input: unknown; usage: LlmUsage }> {
  if (!opts.apiKey) {
    throw new LlmError('ANTHROPIC_API_KEY is not configured', 'config');
  }
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) throw new LlmError('no fetch implementation available', 'config');

  const body = JSON.stringify({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system,
    messages: [{ role: 'user', content: userContent }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name }
  });

  let lastErr: LlmError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body
      });
    } catch (err) {
      lastErr = new LlmError(`request failed: ${(err as Error).message}`, 'http');
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new LlmError(`Anthropic API ${res.status}`, 'http');
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(`Anthropic API ${res.status}: ${text.slice(0, 300)}`, 'http');
    }
    const json = (await res.json().catch(() => null)) as AnthropicResponse | null;
    if (!json) throw new LlmError('malformed JSON response', 'shape');
    const toolUse = (json.content ?? []).find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (!toolUse || toolUse.input === undefined) {
      throw new LlmError('model did not return the expected tool call', 'shape');
    }
    return {
      input: toolUse.input,
      usage: {
        tokensIn: json.usage?.input_tokens ?? 0,
        tokensOut: json.usage?.output_tokens ?? 0
      }
    };
  }
  throw lastErr ?? new LlmError('exhausted retries', 'http');
}

// --------------------------- public API ---------------------------

const DEFAULT_PLANNER_SYSTEM =
  'You are a senior tech lead. Split the given product plan into small, ' +
  'independently-shippable coding tasks. Each task should be completable by one ' +
  'coding agent in a single focused session, produce a self-contained branch, and ' +
  'have clear acceptance criteria. Order tasks so dependencies come first and ' +
  'declare them via depends_on. Prefer 3–12 tasks; never bundle unrelated work.';

export interface SplitPlanInput extends LlmCallOptions {
  /** Overrides the default planner system prompt when non-empty. */
  systemPrompt?: string;
  planMd: string;
  /** Active project-memory lessons to fold into the planning context. */
  lessons?: string[];
}

export async function splitPlan(
  input: SplitPlanInput
): Promise<{ result: PlanSplitResult; usage: LlmUsage }> {
  const system = input.systemPrompt && input.systemPrompt.trim() ? input.systemPrompt : DEFAULT_PLANNER_SYSTEM;
  const lessons =
    input.lessons && input.lessons.length
      ? `\n\nKnown recurring issues in this repo — design tasks to avoid these:\n` +
        input.lessons.map((l) => `- ${l}`).join('\n')
      : '';
  const userContent = `Product plan:\n\n${input.planMd}${lessons}`;
  const { input: raw, usage } = await callTool(input, system, userContent, PLAN_TOOL);
  const parsed = PlanSplitSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LlmError(`plan split failed validation: ${parsed.error.message}`, 'validation');
  }
  return { result: parsed.data, usage };
}

const DEFAULT_QC_SYSTEM =
  'You are a meticulous senior code reviewer. Assess the given code change for ' +
  'correctness, DRY violations, dead code, naming, tight coupling, missing tests, ' +
  'error handling, and security. Return verdict="fail" if there are any medium or ' +
  'high severity issues that should be fixed before merge; otherwise "pass". List ' +
  'each issue with a stable category (dry, testing, style, security, perf, ' +
  'error-handling, correctness).';

export interface QcVerdictInput extends LlmCallOptions {
  /** Overrides the default QC system prompt when non-empty (the QC role prompt). */
  systemPrompt?: string;
  taskTitle: string;
  taskBody: string;
  diff: string;
  /** Transcript / notes the QC agent produced, if any. */
  qcNotes?: string;
  lessons?: string[];
}

export async function qcVerdict(
  input: QcVerdictInput
): Promise<{ result: QcVerdict; usage: LlmUsage }> {
  const system = input.systemPrompt && input.systemPrompt.trim() ? input.systemPrompt : DEFAULT_QC_SYSTEM;
  const lessons =
    input.lessons && input.lessons.length
      ? `\n\nThis repo has these recurring issue classes — weigh them:\n` +
        input.lessons.map((l) => `- ${l}`).join('\n')
      : '';
  const notes = input.qcNotes ? `\n\nQC agent notes:\n${input.qcNotes}` : '';
  const userContent =
    `Task: ${input.taskTitle}\n\n${input.taskBody}\n\n` +
    `Git diff under review:\n\n${input.diff}${notes}${lessons}`;
  const { input: raw, usage } = await callTool(input, system, userContent, QC_TOOL);
  const parsed = QcVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LlmError(`qc verdict failed validation: ${parsed.error.message}`, 'validation');
  }
  return { result: parsed.data, usage };
}
