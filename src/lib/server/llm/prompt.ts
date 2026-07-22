/**
 * Prompt assembly for the "Show Changes" Q&A.
 *
 * We re-render the structured {@link DiffSection}s back to unified-diff text
 * (the shape an LLM reads best) and enforce a char budget so a huge change set
 * can't blow up cost/latency — trailing hunks are dropped first, with a marker
 * so the model knows its context is incomplete.
 */

import type { DiffFile, DiffHunk, DiffSection } from '$lib/server/git/agentDiff';

export type QaSectionKind = 'committed' | 'uncommitted';

export interface QaHistoryTurn {
  q: string;
  a: string;
}

export interface BuildPromptInput {
  committed: DiffSection;
  uncommitted: DiffSection;
  sections: QaSectionKind[];
  history: QaHistoryTurn[];
  question: string;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

/** ~4 chars/token → ~40k tokens of diff; comfortably within the context window. */
const DIFF_CHAR_BUDGET = 160_000;

const SYSTEM =
  'You are a code reviewer explaining a git diff to the repository owner. ' +
  'Answer only from the diff provided. If the diff does not contain the answer, ' +
  'say so plainly rather than guessing. Respond in concise Markdown.';

export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const parts: string[] = [];
  let budget = DIFF_CHAR_BUDGET;

  for (const kind of input.sections) {
    const section = kind === 'committed' ? input.committed : input.uncommitted;
    const label = kind === 'committed' ? 'Committed changes' : 'Uncommitted changes';
    const { text, remaining } = renderSection(section, budget);
    budget = remaining;
    parts.push(`## ${label}\n\n\`\`\`diff\n${text}\n\`\`\``);
  }

  const history = input.history
    .map((t, i) => `### Earlier Q${i + 1}\nQ: ${t.q}\nA: ${t.a}`)
    .join('\n\n');

  const user = [
    parts.join('\n\n'),
    history ? `## Earlier questions\n\n${history}` : '',
    `## Question\n\n${input.question.trim()}`
  ]
    .filter(Boolean)
    .join('\n\n');

  return { system: SYSTEM, user };
}

function renderSection(
  section: DiffSection,
  budget: number
): { text: string; remaining: number } {
  if (section.files.length === 0) {
    return { text: '(no changes)', remaining: budget };
  }
  const out: string[] = [];
  let remaining = budget;
  let dropped = false;

  for (const file of section.files) {
    const block = renderFile(file);
    if (block.length > remaining) {
      dropped = true;
      // Still list the file header so the model knows it exists.
      out.push(`${fileHeader(file)}\n[diff truncated for length]`);
      remaining = 0;
      continue;
    }
    out.push(block);
    remaining -= block.length;
  }

  if (dropped) out.push('[diff truncated for length]');
  return { text: out.join('\n'), remaining };
}

function fileHeader(file: DiffFile): string {
  const from = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : '';
  const stat = file.binary ? '(binary)' : `+${file.added} -${file.removed}`;
  return `# ${file.status} ${from}${file.path} ${stat}`;
}

function renderFile(file: DiffFile): string {
  const lines = [fileHeader(file)];
  if (file.binary) {
    lines.push('Binary file changed.');
    return lines.join('\n');
  }
  if (file.hunks.length === 0) {
    lines.push(file.truncated ? '[large change — stats only]' : '(no textual changes)');
    return lines.join('\n');
  }
  for (const hunk of file.hunks) lines.push(renderHunk(hunk));
  return lines.join('\n');
}

function renderHunk(hunk: DiffHunk): string {
  const body = hunk.lines.map((l) => {
    const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
    return `${sign}${l.text}`;
  });
  return [hunk.header, ...body].join('\n');
}
