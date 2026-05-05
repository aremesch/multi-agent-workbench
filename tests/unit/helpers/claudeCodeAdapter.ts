/**
 * Shared loader for the production `cli-adapters/claude-code.jsonc`.
 *
 * Both the synthetic suite (`src/lib/server/agents/adapters/claude-code-lifecycle.test.ts`)
 * and the live integration test (`tests/integration/claude-code-live.test.ts`)
 * exercise the *real* adapter config rather than a synthetic one, so that
 * any change to claude-code.jsonc is exercised by the test layer it covers.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { adapterConfigSchema } from '../../../src/lib/server/agents/adapters/adapter.config.schema.js';
import { ConfigDrivenAdapter } from '../../../src/lib/server/agents/adapters/ConfigDrivenAdapter.js';

export function loadClaudeCodeAdapter(): ConfigDrivenAdapter {
  const path = join(process.cwd(), 'cli-adapters/claude-code.jsonc');
  const errors: import('jsonc-parser').ParseError[] = [];
  const raw: unknown = parseJsonc(readFileSync(path, 'utf8'), errors, {
    allowTrailingComma: true
  });
  if (errors.length > 0) {
    throw new Error(`claude-code.jsonc parse errors: ${JSON.stringify(errors)}`);
  }
  const cfg = adapterConfigSchema.parse(raw);
  return new ConfigDrivenAdapter(cfg);
}
