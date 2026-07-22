/**
 * Anthropic implementation of {@link LlmProvider}.
 *
 * Credential resolution (see the "Show Changes" plan): prefer a Claude Code
 * OAuth subscription token, fall back to a Console API key, and report
 * unconfigured when neither is set. An OAuth token authenticates via
 * `Authorization: Bearer` (the SDK's `authToken` option) plus the
 * `anthropic-beta: oauth-2025-04-20` header required for `/v1/messages`; an
 * API key uses the normal `x-api-key` path.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '$lib/server/config';
import type { LlmAnswerRequest, LlmProvider } from './index';

/** Non-streaming, modest cap: the Q&A answer is short, so no timeout risk. */
const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 2048;
const OAUTH_BETA = 'oauth-2025-04-20';

export class AnthropicProvider implements LlmProvider {
  isConfigured(): boolean {
    const { claudeCodeOauthToken, anthropicApiKey } = getConfig();
    return Boolean(claudeCodeOauthToken || anthropicApiKey);
  }

  async answer(req: LlmAnswerRequest): Promise<string> {
    const client = this.#makeClient();
    if (!client) throw new Error('llm_not_configured');

    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages: [{ role: 'user', content: req.user }]
    });

    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  #makeClient(): Anthropic | null {
    const { claudeCodeOauthToken, anthropicApiKey } = getConfig();
    if (claudeCodeOauthToken) {
      return new Anthropic({
        authToken: claudeCodeOauthToken,
        defaultHeaders: { 'anthropic-beta': OAUTH_BETA }
      });
    }
    if (anthropicApiKey) {
      return new Anthropic({ apiKey: anthropicApiKey });
    }
    return null;
  }
}
