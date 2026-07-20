/**
 * LLM facade for the "Show Changes" Q&A panel.
 *
 * This is MAW's first direct LLM call — every agent otherwise runs as an
 * interactive tmux TUI, so there is no existing prompt→completion path to
 * reuse. The provider is chosen from config at call time (Anthropic today);
 * OpenAI/Gemini can slot in later behind a future `MAW_LLM_PROVIDER` without
 * touching callers.
 */

import { getConfig } from '$lib/server/config';
import { AnthropicProvider } from './anthropic';

export interface LlmAnswerRequest {
  /** System framing. */
  system: string;
  /** Fully-assembled user message (diff + history + question). */
  user: string;
}

export interface LlmProvider {
  isConfigured(): boolean;
  /** Answer a question; returns Markdown. */
  answer(req: LlmAnswerRequest): Promise<string>;
}

let _provider: LlmProvider | null = null;

function provider(): LlmProvider {
  if (!_provider) _provider = new AnthropicProvider();
  return _provider;
}

/** Whether the Q&A panel is usable (a credential is configured). */
export function isConfigured(): boolean {
  return provider().isConfigured();
}

/** Answer a diff question. Throws on network / API failure; the route maps it to 502. */
export function answer(req: LlmAnswerRequest): Promise<string> {
  return provider().answer(req);
}

/** Reset the memoized provider — test seam only. */
export function _resetProvider(): void {
  _provider = null;
}

// Re-export so `getConfig` stays the single source of credential truth in tests.
export { getConfig };
