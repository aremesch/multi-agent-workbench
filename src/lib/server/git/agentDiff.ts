/**
 * Diff-discovery helpers for the agent-window kebab "Show Changes" action.
 *
 * Conceptual model: every coding agent runs inside a git worktree anchored at
 * an immutable `base_sha` (the start point it was branched from — see
 * `WorktreeManager.create`). "What this agent changed" is therefore two things,
 * surfaced as two separate sections in the UI:
 *
 *   - COMMITTED   — `base_sha..HEAD`: everything the agent has committed on its
 *                   branch since it started.
 *   - UNCOMMITTED — the working tree: staged + unstaged edits to tracked files,
 *                   plus untracked files, that haven't been committed yet.
 *
 * We parse git's unified-diff output **server-side** into a structured shape
 * (see {@link ChangesResponse}) rather than shipping a raw patch blob to the
 * client. This lets the phone lazily build hunk DOM on expand, compute stat
 * badges without re-parsing, and — crucially — lets us enforce size caps here
 * so a giant refactor never crosses the wire or freezes a mobile browser.
 *
 * Only reads. Never mutates the worktree (no `git add -N`, no staging).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getGit } from './client';

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  /** Old-file line number — present for context + del, null for add. */
  oldNo: number | null;
  /** New-file line number — present for context + add, null for del. */
  newNo: number | null;
  /** Line content WITHOUT the leading +/-/space marker. */
  text: string;
}

export interface DiffHunk {
  /** Raw `@@ -a,b +c,d @@ …` header for display. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  /** New path (old path for deletes). */
  path: string;
  /** Set only for renames (R) and copies (C). */
  oldPath: string | null;
  status: ChangeStatus;
  /** Added line count; `-1` when binary. */
  added: number;
  /** Removed line count; `-1` when binary. */
  removed: number;
  binary: boolean;
  /** Empty when binary or when this file's hunks were dropped by a size cap. */
  hunks: DiffHunk[];
  /** True when this file's hunks were omitted (too large / over the section cap). */
  truncated: boolean;
}

export type DiffSectionNote =
  | 'base_unavailable'
  | 'worktree_gone'
  | 'no_commits'
  | null;

export interface DiffSection {
  kind: 'committed' | 'uncommitted';
  files: DiffFile[];
  totalAdded: number;
  totalRemoved: number;
  /** True when some files had their hunks dropped by a size cap. */
  truncated: boolean;
  note: DiffSectionNote;
}

export interface AgentChanges {
  committed: DiffSection;
  uncommitted: DiffSection;
  baseSha: string | null;
  headSha: string | null;
}

/** The well-known git empty-tree object — diffing against it yields all-adds. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Per-file caps: beyond either, we drop hunks and keep stats only. */
const PER_FILE_LINE_CAP = 1500;
const PER_FILE_BYTE_CAP = 200 * 1024;
/** Section-wide hunk byte budget; once exhausted, remaining files list stats only. */
const TOTAL_BYTE_CAP = 2 * 1024 * 1024;
/** Guard for reading an untracked file into memory. */
const UNTRACKED_READ_CAP = 2 * 1024 * 1024;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Full change set for an agent: committed (`base_sha..HEAD`) + uncommitted
 * (working tree). Returns friendly empty sections (with a `note`) rather than
 * throwing when the worktree is gone or the base SHA is unreachable, so the UI
 * can always render *something*.
 */
export async function getAgentChanges(
  worktreePath: string,
  baseSha: string | null
): Promise<AgentChanges> {
  if (!worktreePath || !existsSync(worktreePath)) {
    return {
      committed: emptySection('committed', 'worktree_gone'),
      uncommitted: emptySection('uncommitted', 'worktree_gone'),
      baseSha,
      headSha: null
    };
  }
  const [committed, uncommitted, headSha] = await Promise.all([
    getCommittedDiff(worktreePath, baseSha),
    getUncommittedDiff(worktreePath),
    resolveHead(worktreePath)
  ]);
  return { committed, uncommitted, baseSha, headSha };
}

/** Committed changes on the agent's branch: `base_sha..HEAD`. */
export async function getCommittedDiff(
  worktreePath: string,
  baseSha: string | null
): Promise<DiffSection> {
  if (!baseSha) return emptySection('committed', 'base_unavailable');
  const git = getGit(worktreePath);

  // Fast guard: if base_sha doesn't resolve to a commit (rebased away, GC'd),
  // the diff would throw — short-circuit to a friendly empty section.
  try {
    await git.revparse(['--verify', `${baseSha}^{commit}`]);
  } catch {
    return emptySection('committed', 'base_unavailable');
  }

  let patch: string;
  let numstat: string;
  try {
    const range = `${baseSha}..HEAD`;
    [patch, numstat] = await Promise.all([
      rawDiff(worktreePath, ['--patch', '-M', '--no-color', range]),
      rawDiff(worktreePath, ['--numstat', '-M', range])
    ]);
  } catch {
    // HEAD unborn or otherwise unreachable — nothing committed to show.
    return emptySection('committed', 'base_unavailable');
  }

  const files = mergeNumstat(parseUnifiedDiff(patch), numstat);
  return buildSection('committed', files, null);
}

/**
 * Uncommitted working-tree changes: staged + unstaged edits to tracked files,
 * plus untracked files. When HEAD is unborn (no commits yet) we diff against
 * the empty tree so a fresh worktree still shows its staged content.
 */
export async function getUncommittedDiff(worktreePath: string): Promise<DiffSection> {
  let note: DiffSectionNote = null;
  let trackedFiles: DiffFile[] = [];

  try {
    const [patch, numstat] = await Promise.all([
      rawDiff(worktreePath, ['--patch', '-M', '--no-color', 'HEAD']),
      rawDiff(worktreePath, ['--numstat', '-M', 'HEAD'])
    ]);
    trackedFiles = mergeNumstat(parseUnifiedDiff(patch), numstat);
  } catch {
    // Unborn HEAD: diff the working tree against the empty tree instead.
    note = 'no_commits';
    try {
      const [patch, numstat] = await Promise.all([
        rawDiff(worktreePath, ['--patch', '-M', '--no-color', EMPTY_TREE]),
        rawDiff(worktreePath, ['--numstat', '-M', EMPTY_TREE])
      ]);
      trackedFiles = mergeNumstat(parseUnifiedDiff(patch), numstat);
    } catch {
      trackedFiles = [];
    }
  }

  const untrackedFiles = await listUntrackedFiles(worktreePath);
  return buildSection('uncommitted', [...trackedFiles, ...untrackedFiles], note);
}

// ── Pure parsing (exported for unit tests) ──────────────────────────────────

/**
 * Parse `git diff --patch` output into structured {@link DiffFile}s. Tolerates
 * renames/copies, deletes, binary markers, and `\ No newline at end of file`.
 * Line numbering is tracked per hunk from the `@@` header.
 */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!patch) return files;

  const lines = patch.split('\n');
  let cur: DiffFile | null = null;
  let curHunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const flushHunk = (): void => {
    if (cur && curHunk) {
      cur.hunks.push(curHunk);
      curHunk = null;
    }
  };
  const flushFile = (): void => {
    flushHunk();
    if (cur) {
      files.push(cur);
      cur = null;
    }
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushFile();
      cur = {
        path: '',
        oldPath: null,
        status: 'M',
        added: 0,
        removed: 0,
        binary: false,
        hunks: [],
        truncated: false
      };
      const paths = parseDiffGitLine(line);
      if (paths) {
        cur.path = paths.b;
      }
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('@@')) {
      flushHunk();
      const h = parseHunkHeader(line);
      if (h) {
        curHunk = { header: line, ...h, lines: [] };
        oldNo = h.oldStart;
        newNo = h.newStart;
      }
      continue;
    }

    if (curHunk === null) {
      // Extended-header region (before the first hunk).
      if (line.startsWith('new file mode')) cur.status = 'A';
      else if (line.startsWith('deleted file mode')) cur.status = 'D';
      else if (line.startsWith('rename from ')) {
        cur.oldPath = unquotePath(line.slice('rename from '.length));
        cur.status = 'R';
      } else if (line.startsWith('rename to ')) {
        cur.path = unquotePath(line.slice('rename to '.length));
        cur.status = 'R';
      } else if (line.startsWith('copy from ')) {
        cur.oldPath = unquotePath(line.slice('copy from '.length));
        cur.status = 'C';
      } else if (line.startsWith('copy to ')) {
        cur.path = unquotePath(line.slice('copy to '.length));
        cur.status = 'C';
      } else if (line.startsWith('--- ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') cur.oldPath = stripDiffPrefix(p);
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p === '/dev/null') cur.status = 'D';
        else cur.path = stripDiffPrefix(p);
      } else if (line.startsWith('Binary files')) {
        cur.binary = true;
        const paths = parseBinaryLine(line);
        if (paths) {
          if (paths.a) cur.oldPath = cur.oldPath ?? paths.a;
          if (paths.b) cur.path = paths.b;
        }
      }
      continue;
    }

    // Hunk body.
    const marker = line[0];
    if (marker === '\\') {
      // "\ No newline at end of file" — attach to prior line, no numbering.
      continue;
    }
    if (marker === '+') {
      curHunk.lines.push({ type: 'add', oldNo: null, newNo, text: line.slice(1) });
      newNo++;
      cur.added++;
    } else if (marker === '-') {
      curHunk.lines.push({ type: 'del', oldNo, newNo: null, text: line.slice(1) });
      oldNo++;
      cur.removed++;
    } else {
      // Context (leading space) or a stray blank line inside the hunk.
      const text = line.startsWith(' ') ? line.slice(1) : line;
      curHunk.lines.push({ type: 'context', oldNo, newNo, text });
      oldNo++;
      newNo++;
    }
  }

  flushFile();
  return files;
}

/**
 * Overlay authoritative `git diff --numstat` counts + binary flags onto parsed
 * files, keyed by new path. numstat is the source of truth for line counts and
 * for binary detection (`-\t-`).
 */
export function mergeNumstat(files: DiffFile[], numstat: string): DiffFile[] {
  if (!numstat) return files;
  const byPath = new Map<string, DiffFile>();
  for (const f of files) byPath.set(f.path, f);

  for (const line of numstat.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addedRaw, removedRaw, ...rest] = parts;
    const newPath = parseNumstatPath(rest.join('\t'));
    const f = byPath.get(newPath);
    if (!f) continue;
    if (addedRaw === '-' || removedRaw === '-') {
      f.binary = true;
      f.added = -1;
      f.removed = -1;
      f.hunks = [];
    } else {
      f.added = Number(addedRaw);
      f.removed = Number(removedRaw);
    }
  }
  return files;
}

// ── Internals ───────────────────────────────────────────────────────────────

function emptySection(kind: DiffSection['kind'], note: DiffSectionNote): DiffSection {
  return { kind, files: [], totalAdded: 0, totalRemoved: 0, truncated: false, note };
}

/**
 * Apply per-file + section byte caps, then compute totals. Files whose hunks are
 * dropped keep their stats and are flagged `truncated` so the UI can say so.
 */
function buildSection(
  kind: DiffSection['kind'],
  files: DiffFile[],
  note: DiffSectionNote
): DiffSection {
  let budget = TOTAL_BYTE_CAP;
  let sectionTruncated = false;
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const f of files) {
    if (f.added > 0) totalAdded += f.added;
    if (f.removed > 0) totalRemoved += f.removed;
    if (f.binary || f.hunks.length === 0) continue;

    const lineCount = f.hunks.reduce((n, h) => n + h.lines.length, 0);
    const bytes = f.hunks.reduce(
      (n, h) => n + h.header.length + h.lines.reduce((m, l) => m + l.text.length + 1, 0),
      0
    );
    if (lineCount > PER_FILE_LINE_CAP || bytes > PER_FILE_BYTE_CAP || budget <= 0) {
      f.hunks = [];
      f.truncated = true;
      sectionTruncated = true;
      continue;
    }
    budget -= bytes;
  }

  return { kind, files, totalAdded, totalRemoved, truncated: sectionTruncated, note };
}

/** Run `git -c core.quotepath=false diff <args>` and return stdout. */
async function rawDiff(worktreePath: string, args: string[]): Promise<string> {
  return getGit(worktreePath).raw(['-c', 'core.quotepath=false', 'diff', ...args]);
}

async function resolveHead(worktreePath: string): Promise<string | null> {
  try {
    return (await getGit(worktreePath).revparse(['HEAD'])).trim();
  } catch {
    return null;
  }
}

/**
 * Untracked files as all-add {@link DiffFile}s. We enumerate via
 * `git ls-files --others --exclude-standard` (expands untracked directories to
 * individual files, honours .gitignore) and read each file ourselves — avoiding
 * `git diff --no-index`, which exits non-zero on differences and would make
 * simple-git throw.
 */
async function listUntrackedFiles(worktreePath: string): Promise<DiffFile[]> {
  let out: string;
  try {
    out = await getGit(worktreePath).raw([
      '-c',
      'core.quotepath=false',
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z'
    ]);
  } catch {
    return [];
  }
  const rels = out.split('\0').filter(Boolean);
  const files = await Promise.all(rels.map((rel) => readUntrackedFile(worktreePath, rel)));
  return files.filter((f): f is DiffFile => f !== null);
}

async function readUntrackedFile(worktreePath: string, rel: string): Promise<DiffFile | null> {
  const abs = resolve(worktreePath, rel);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    return null; // vanished between ls-files and read, or is a special file
  }

  const base: DiffFile = {
    path: rel,
    oldPath: null,
    status: 'A',
    added: 0,
    removed: 0,
    binary: false,
    hunks: [],
    truncated: false
  };

  // Binary sniff: a NUL byte in the head is git's own heuristic.
  const sniff = buf.subarray(0, 8000);
  if (sniff.includes(0)) {
    return { ...base, binary: true, added: -1, removed: -1 };
  }
  if (buf.byteLength > UNTRACKED_READ_CAP) {
    return { ...base, truncated: true };
  }

  const text = buf.toString('utf8');
  const rawLines = text.split('\n');
  // A trailing newline yields a final empty element — drop it (it's the EOL of
  // the last real line, not a line of its own).
  const hadTrailingNewline = text.endsWith('\n');
  if (hadTrailingNewline) rawLines.pop();
  if (rawLines.length === 0) {
    return { ...base, added: 0 };
  }

  const lines: DiffLine[] = rawLines.map((text, i) => ({
    type: 'add' as const,
    oldNo: null,
    newNo: i + 1,
    text
  }));
  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${lines.length} @@`,
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines
  };
  return { ...base, added: lines.length, hunks: [hunk] };
}

interface HunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

function parseHunkHeader(line: string): HunkRange | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4])
  };
}

/** Best-effort path extraction from a `diff --git a/… b/…` line. */
function parseDiffGitLine(line: string): { a: string; b: string } | null {
  const rest = line.slice('diff --git '.length);
  // Quoted form: at least one side is C-quoted.
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest);
    if (m && m[1] && m[2]) return { a: stripDiffPrefix(m[1]), b: stripDiffPrefix(m[2]) };
  }
  // Unquoted: split on ' b/'. Ambiguous with spaces, but ---/+++/rename lines
  // are the authoritative source; this is only a fallback for binaries.
  const idx = rest.indexOf(' b/');
  if (idx > 0) {
    return { a: stripDiffPrefix(rest.slice(0, idx)), b: stripDiffPrefix(rest.slice(idx + 1)) };
  }
  return null;
}

function parseBinaryLine(line: string): { a: string | null; b: string | null } | null {
  // "Binary files a/x and b/y differ"
  const body = line.replace(/^Binary files /, '').replace(/ differ$/, '');
  const sep = ' and ';
  const idx = body.indexOf(sep);
  if (idx < 0) return null;
  const aRaw = body.slice(0, idx);
  const bRaw = body.slice(idx + sep.length);
  return {
    a: aRaw === '/dev/null' ? null : stripDiffPrefix(aRaw),
    b: bRaw === '/dev/null' ? null : stripDiffPrefix(bRaw)
  };
}

/** Strip the leading `a/` or `b/` diff prefix, unquoting first if needed. */
function stripDiffPrefix(p: string): string {
  const unq = unquotePath(p.trim());
  if (unq.startsWith('a/') || unq.startsWith('b/')) return unq.slice(2);
  return unq;
}

/**
 * Decode a possibly C-quoted git path. With `core.quotepath=false` only paths
 * containing quotes, backslashes, or control chars get quoted, so this handles
 * the common escapes plus octal byte escapes.
 */
function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      bytes.push(inner.charCodeAt(i));
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      const oct = inner.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8) & 0xff);
      i += 3;
    } else {
      const map: Record<string, number> = {
        n: 10,
        t: 9,
        r: 13,
        '"': 34,
        '\\': 92
      };
      bytes.push(map[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Reduce a numstat path field to the new path. `-M` renames appear as
 * `old => new` or `pre/{old => new}/post` — both resolve to the new path.
 */
export function parseNumstatPath(field: string): string {
  const trimmed = unquotePath(field.trim());
  const brace = /\{(.*?) => (.*?)\}/.exec(trimmed);
  if (brace) {
    return trimmed.replace(brace[0], brace[2] ?? '').replace(/\/\//g, '/');
  }
  const arrow = trimmed.indexOf(' => ');
  if (arrow >= 0) return trimmed.slice(arrow + ' => '.length);
  return trimmed;
}
