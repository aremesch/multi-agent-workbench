/**
 * ClaudeJsonlTokens — aggregate token usage from a Claude Code JSONL transcript.
 *
 * Claude Code persists a `usage` object on every `assistant` entry in the
 * session JSONL. We read the file, sum up the token fields, and return a
 * compact summary suitable for the archive dashboard.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

interface JsonlUsageEntry {
  type?: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/**
 * Map an absolute filesystem path to the directory name Claude Code uses
 * under `~/.claude/projects/`. Empirically: every `/` and `.` becomes `-`.
 */
function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export function jsonlPathFor(cwd: string, sessionId: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwdForClaude(cwd), `${sessionId}.jsonl`);
}

/**
 * Read token usage from a JSONL transcript file. Returns null if the file
 * doesn't exist (agent never ran or isn't claude-code).
 */
export async function summarizeTokenUsage(filePath: string): Promise<TokenUsageSummary | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const summary: TokenUsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: JsonlUsageEntry;
    try {
      entry = JSON.parse(line) as JsonlUsageEntry;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    summary.inputTokens += usage.input_tokens ?? 0;
    summary.outputTokens += usage.output_tokens ?? 0;
    summary.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    summary.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  }

  return summary;
}
