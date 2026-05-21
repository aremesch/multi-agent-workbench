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

import { agentClaudeConfigDir } from '../claudeConfigDir.js';

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
 * under its `projects/` dir. Empirically: every `/` and `.` becomes `-`.
 */
function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Resolve a JSONL transcript path under an arbitrary claude config root.
 * Claude Code writes transcripts to `<configRoot>/projects/<encoded-cwd>/<sessionId>.jsonl`
 * — `configRoot` defaults to `~/.claude/` when `CLAUDE_CONFIG_DIR` is unset.
 */
export function jsonlPathInRoot(configRoot: string, cwd: string, sessionId: string): string {
  return join(configRoot, 'projects', encodeCwdForClaude(cwd), `${sessionId}.jsonl`);
}

/**
 * Back-compat: resolve under the user-global `~/.claude/`. Still used for
 * agents that ran before per-agent `CLAUDE_CONFIG_DIR` isolation landed —
 * their transcripts live in the shared tree.
 */
export function jsonlPathFor(cwd: string, sessionId: string): string {
  return jsonlPathInRoot(join(homedir(), '.claude'), cwd, sessionId);
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

/**
 * Resolve the right transcript path for `agentId` and summarize it. Prefers
 * the per-agent isolated config dir (where claude-code writes for agents
 * spawned under `CLAUDE_CONFIG_DIR`), and falls back to the user-global
 * `~/.claude/projects/` so we keep reading transcripts for archived agents
 * that ran before the isolation fix landed.
 */
export async function summarizeTokenUsageForAgent(
  agentId: string,
  cwd: string,
  sessionId: string
): Promise<TokenUsageSummary | null> {
  const isolated = jsonlPathInRoot(agentClaudeConfigDir(agentId), cwd, sessionId);
  const fromIsolated = await summarizeTokenUsage(isolated);
  if (fromIsolated !== null) return fromIsolated;
  return summarizeTokenUsage(jsonlPathFor(cwd, sessionId));
}
