/**
 * ClaudeJsonlHistory — read Claude Code's session transcript and render it
 * to plain text for prepending to the reconnect terminal snapshot.
 *
 * Why this exists: tmux scrollback for TUI CLIs is full of repaint ghosts,
 * so we capture only the visible pane on reconnect (`scrollbackMode:
 * "visible"`). That loses every conversation turn that has scrolled out of
 * the visible viewport. Claude itself persists the same data losslessly to
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — that's the file
 * `claude --resume` reads. We read it too, render it as plain text, and the
 * client writes it into xterm scrollback before applying the live capture.
 *
 * Renderer is intentionally dumb (plain ASCII, no markdown, no syntax
 * highlight) — xterm.js displays the bytes verbatim and the live live frame
 * underneath is still the source of truth for current screen state.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Per-block truncation budget — tool args/results can be megabytes. */
const TOOL_PREVIEW_BUDGET = 200;
/** Total output budget — protect the WS payload + xterm scrollback ring. */
const TOTAL_OUTPUT_BUDGET = 256 * 1024;

/**
 * Map an absolute filesystem path to the directory name Claude Code uses
 * under `~/.claude/projects/`. Empirically: every `/` and `.` becomes `-`,
 * other characters pass through. Verified against the worktree's own
 * transcript directory at implementation time.
 */
export function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export function jsonlPathFor(cwd: string, sessionId: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwdForClaude(cwd), `${sessionId}.jsonl`);
}

interface JsonlEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Read the JSONL transcript and produce a single plain-text rendering. Returns
 * `null` if the file doesn't exist yet (fresh agent, hasn't written its first
 * turn) — the hub treats `null` as "skip the history snapshot."
 */
export async function renderClaudeJsonlHistory(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const out: string[] = [];
  let totalLen = 0;
  let truncated = false;

  const push = (s: string): boolean => {
    if (totalLen + s.length > TOTAL_OUTPUT_BUDGET) {
      truncated = true;
      return false;
    }
    out.push(s);
    totalLen += s.length;
    return true;
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      // Skip malformed lines defensively — schema can drift.
      continue;
    }
    const rendered = renderEntry(entry);
    if (!rendered) continue;
    if (!push(rendered)) break;
  }

  if (out.length === 0) return null;
  if (truncated) {
    out.unshift('--- (history truncated to most recent entries above) ---\n\n');
  }
  out.push('\n--- end of session history ---\n\n');

  // tmux/xterm path normalization: live PTY uses CRLF and the panel mounts
  // xterm with convertEol=false. Match that so this snapshot doesn't
  // stairstep across the screen.
  return out.join('').replace(/\r?\n/g, '\r\n');
}

function renderEntry(entry: JsonlEntry): string | null {
  // Outer `type === "user"` covers both real prompts and tool_result echoes.
  if (entry.type === 'user' && entry.message) {
    return renderUserMessage(entry.message.content);
  }
  // Outer `type === "message"` (with role assistant) is the model's reply.
  if (entry.type === 'message' && entry.message?.role === 'assistant') {
    return renderAssistantMessage(entry.message.content);
  }
  return null;
}

function renderUserMessage(content: unknown): string | null {
  if (typeof content === 'string') {
    return `\n──── user ────\n${content.trim()}\n`;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; content?: unknown; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text.trim());
    } else if (b.type === 'tool_result') {
      const preview = previewToolResult(b.content);
      parts.push(`▸ tool_result: ${preview}`);
    }
  }
  if (parts.length === 0) return null;
  // Pure-tool_result entries are bookkeeping; only surface user-typed text.
  const hasOnlyToolResults = parts.every((p) => p.startsWith('▸ tool_result:'));
  if (hasOnlyToolResults) return null;
  return `\n──── user ────\n${parts.join('\n')}\n`;
}

function renderAssistantMessage(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as {
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
    };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text.trim());
    } else if (b.type === 'tool_use') {
      parts.push(`▸ ${b.name ?? 'tool'}(${previewToolInput(b.input)})`);
    }
    // 'thinking' blocks are intentionally skipped — they're noise in scrollback.
  }
  if (parts.length === 0) return null;
  return `\n──── assistant ────\n${parts.join('\n')}\n`;
}

function previewToolInput(input: unknown): string {
  if (input == null) return '';
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return truncate(s.replace(/\s+/g, ' '), TOOL_PREVIEW_BUDGET);
}

function previewToolResult(content: unknown): string {
  if (typeof content === 'string') {
    return truncate(content.replace(/\s+/g, ' '), TOOL_PREVIEW_BUDGET);
  }
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join(' ');
    return truncate(text.replace(/\s+/g, ' '), TOOL_PREVIEW_BUDGET);
  }
  return '';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
