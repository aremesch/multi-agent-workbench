/**
 * Plan-discovery + render helpers for the agent-window kebab "Show Plan"
 * action.
 *
 * Conceptual model: every coding agent runs inside a git worktree. By
 * convention (see the global `~/.claude/CLAUDE.md` rules) plans live at
 * `<worktree>/<plansDirectory>/*.md`, where `plansDirectory` is read
 * from `<worktree>/.claude/settings.json` (key `plansDirectory`) and
 * defaults to `docs/plans`. We call those "local" plans.
 *
 * In addition we surface "global" plans from `~/.claude/plans/` —
 * Claude Code's default plan-output location when a project doesn't
 * set `plansDirectory`. The two lists are merged, sorted by mtime
 * desc, and each entry carries a `source` tag so the UI can label
 * them.
 *
 * "The plans for this agent" =
 *   - LOCAL: files under the worktree's plans dir that the agent's
 *     branch has added or modified relative to its base SHA. We fall
 *     back to listing every `*.md` if the base SHA is unreachable.
 *   - GLOBAL: files under `~/.claude/plans` whose mtime is at or
 *     after `agent.created_at − 60s` (a heuristic — there's no
 *     authoritative agent↔global-plan link without parsing Claude
 *     Code's stdout for the announced path; the −60s buffer absorbs
 *     clock skew between plan-mode activation and the DB row insert).
 *
 * Markdown is rendered server-side via `marked` then sanitized with
 * DOMPurify (HTML profile) before it crosses the wire. Plan files are
 * authored by the agent itself in a worktree the user owns, so the
 * threat model is mild — but a malicious plan still shouldn't be able
 * to `fetch()` anything when the user opens it, and the parser/sanitizer
 * combo is the standard cure.
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, sep, basename, isAbsolute } from 'node:path';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';
import { getGit } from '$lib/server/git/client';

export type PlanSource = 'local' | 'global';

export interface PlanFileSummary {
  /** Basename, e.g. `v0.2-foo.md`. Never contains a slash. */
  name: string;
  /** mtime in epoch milliseconds. */
  modifiedMs: number;
  /** Size in bytes. */
  sizeBytes: number;
  /** Where this plan came from — `local` = worktree, `global` = `~/.claude/plans`. */
  source: PlanSource;
}

export interface RenderedPlan {
  name: string;
  /** Sanitized HTML ready for `{@html}`. */
  html: string;
  /** Raw markdown the HTML was rendered from. Surfaced to the plan viewer
   *  so the "Copy markdown" button can write the original text to the
   *  clipboard without a second round-trip. */
  markdown: string;
}

const DEFAULT_PLANS_DIR = 'docs/plans';
/** User-friendly label for the global plans dir. */
const GLOBAL_DISPLAY = '~/.claude/plans';
/** Allowed plan filenames. No slashes, no leading dot, must end in `.md`. */
const SAFE_FILENAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/;
/** Skew buffer for the global mtime filter — see file header. */
const GLOBAL_MTIME_SKEW_MS = 60_000;

/** Claude Code's default plan-output dir when no project-level
 *  `plansDirectory` is configured. Single-user app, same UID as MAW. */
function globalPlansDir(): string {
  return resolve(homedir(), '.claude', 'plans');
}

/**
 * User-friendly directory name for the empty-state message. `local`
 * returns the configured/default `plansDir`, `global` returns the
 * `~/.claude/plans` literal so the UI doesn't have to know about
 * homedir resolution.
 */
export function displayDir(source: PlanSource, plansDir: string): string {
  return source === 'global' ? GLOBAL_DISPLAY : plansDir;
}

/**
 * Resolve the plans directory for a given worktree.
 *
 * Reads `<worktree>/.claude/settings.json#plansDirectory` if present,
 * else falls back to `docs/plans`. Validates that the value is a
 * relative path without `..`, absolute components, or empty segments —
 * defense in depth, since `.claude/settings.json` is checked into the
 * worktree and could be supply-chain-attacked.
 */
export async function resolvePlansDir(worktreePath: string): Promise<string> {
  const settingsPath = resolve(worktreePath, '.claude', 'settings.json');
  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch {
    return DEFAULT_PLANS_DIR;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PLANS_DIR;
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_PLANS_DIR;
  const value = (parsed as Record<string, unknown>).plansDirectory;
  if (typeof value !== 'string') return DEFAULT_PLANS_DIR;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_PLANS_DIR;
  if (isAbsolute(trimmed)) return DEFAULT_PLANS_DIR;
  // Reject any `..` segment + sneaky leading-slash variants on Windows-style
  // paths. The regex is purposely strict: only POSIX-style relative paths
  // made of safe chars + slashes are allowed.
  if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) return DEFAULT_PLANS_DIR;
  if (trimmed.split('/').some((seg) => seg === '' || seg === '..' || seg === '.')) {
    return DEFAULT_PLANS_DIR;
  }
  return trimmed;
}

interface RawDirEntry {
  name: string;
  modifiedMs: number;
  sizeBytes: number;
}

/**
 * Enumerate `*.md` files (matching `SAFE_FILENAME_RE`) directly inside
 * `dirAbs`, returning name + mtime + size. Returns `[]` cleanly on any
 * read error (most importantly `ENOENT` for a missing dir, which is
 * normal for a fresh user with no `~/.claude/plans` yet).
 */
async function listMdFromDir(dirAbs: string): Promise<RawDirEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(dirAbs);
  } catch {
    return [];
  }
  const names = entries.filter((e) => SAFE_FILENAME_RE.test(e));
  if (names.length === 0) return [];
  const summaries = await Promise.all(
    names.map(async (name): Promise<RawDirEntry | null> => {
      try {
        const s = await stat(resolve(dirAbs, name));
        return { name, modifiedMs: s.mtimeMs, sizeBytes: s.size };
      } catch {
        // File vanished between readdir and stat — skip it.
        return null;
      }
    })
  );
  return summaries.filter((s): s is RawDirEntry => s !== null);
}

/**
 * Local plans = `*.md` under `<worktreePath>/<plansDir>` that the
 * agent's branch has touched (added or modified) relative to `baseSha`,
 * including uncommitted changes in the working tree. Falls back to
 * listing every `*.md` if `baseSha` is null, unreachable, or the diff
 * fails for any reason — better to over-list than to leave the user
 * with an empty modal.
 */
async function listLocalPlans(
  worktreePath: string,
  plansDir: string,
  baseSha: string | null
): Promise<PlanFileSummary[]> {
  const fullDir = resolve(worktreePath, plansDir);
  // Ensure the resolved path is still inside the worktree.
  const wtRoot = resolve(worktreePath);
  if (!fullDir.startsWith(wtRoot + sep) && fullDir !== wtRoot) {
    return [];
  }

  const all = await listMdFromDir(fullDir);
  if (all.length === 0) return [];

  // Per-agent filter via git. If anything goes wrong we fall back to
  // the full universe so the user still sees something.
  const allowed = await touchedFiles(worktreePath, plansDir, baseSha);
  const filtered = allowed === null ? all : all.filter((f) => allowed.has(f.name));
  return filtered.map((e) => ({ ...e, source: 'local' as const }));
}

/**
 * Global plans = `*.md` under `~/.claude/plans` with an mtime at or
 * after `agentCreatedAtMs − 60s`. The −60s buffer covers wall-clock
 * jitter between Claude Code writing the plan file (at plan-mode
 * activation) and MAW recording the agent row. This is a heuristic,
 * not an exact agent↔plan mapping — see file header.
 */
async function listGlobalPlans(agentCreatedAtMs: number): Promise<PlanFileSummary[]> {
  const cutoff = agentCreatedAtMs - GLOBAL_MTIME_SKEW_MS;
  const entries = await listMdFromDir(globalPlansDir());
  return entries
    .filter((e) => e.modifiedMs >= cutoff)
    .map((e) => ({ ...e, source: 'global' as const }));
}

/**
 * Merged plan listing for an agent: local (worktree, git-filtered) plus
 * global (`~/.claude/plans`, mtime-filtered). Sorted by `modifiedMs`
 * descending so the most recently modified plan is `[0]`.
 */
export async function listAgentPlans(
  worktreePath: string,
  plansDir: string,
  baseSha: string | null,
  agentCreatedAtMs: number
): Promise<PlanFileSummary[]> {
  const [local, global] = await Promise.all([
    listLocalPlans(worktreePath, plansDir, baseSha),
    listGlobalPlans(agentCreatedAtMs)
  ]);
  return [...local, ...global].sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/**
 * Return the set of basenames inside `<plansDir>` that this branch has
 * added or modified relative to `baseSha`. Returns `null` to signal
 * "couldn't determine — show all".
 */
async function touchedFiles(
  worktreePath: string,
  plansDir: string,
  baseSha: string | null
): Promise<Set<string> | null> {
  if (!baseSha) return null;

  const git = getGit(worktreePath);

  // Fast guard: if base_sha doesn't resolve to a commit, the diff would
  // throw — short-circuit to "show all".
  try {
    await git.revparse(['--verify', `${baseSha}^{commit}`]);
  } catch {
    return null;
  }

  const touched = new Set<string>();

  // Committed changes since baseSha. simple-git owns the parsing — just
  // newline-split the --name-only output and basename each.
  try {
    const stdout = await git.diff([
      '--name-only',
      '--diff-filter=AM',
      `${baseSha}..HEAD`,
      '--',
      plansDir
    ]);
    for (const path of stdout.split('\n')) {
      if (!path) continue;
      const name = basename(path);
      if (SAFE_FILENAME_RE.test(name)) touched.add(name);
    }
  } catch {
    // diff failed even though rev-parse succeeded — bail to "show all".
    return null;
  }

  // Plus uncommitted (staged + unstaged) changes. simple-git's status()
  // returns structured FileStatusResult[] — no manual porcelain parsing,
  // no NUL handling, just paths.
  try {
    const result = await git.status([plansDir]);
    for (const entry of result.files) {
      const name = basename(entry.path);
      if (SAFE_FILENAME_RE.test(name)) touched.add(name);
    }
  } catch {
    // status failed — keep what we had from diff (better than nothing).
  }

  return touched;
}

/**
 * Read + render a single plan file. `source` selects the directory:
 *   `local`  → `<worktreePath>/<plansDir>`
 *   `global` → `<homedir>/.claude/plans`
 * Returns null when the file no longer exists (race with `git mv` or
 * external delete) or when the source dir doesn't exist (fresh user
 * with no `~/.claude/plans`). Throws on a filename that fails the
 * safe-filename regex or that resolves outside its source dir (TOCTOU
 * defence against symlink flips).
 */
export async function renderAgentPlan(
  worktreePath: string,
  plansDir: string,
  filename: string,
  source: PlanSource = 'local'
): Promise<RenderedPlan | null> {
  if (!SAFE_FILENAME_RE.test(filename)) {
    throw new Error('invalid_filename');
  }
  const dirAbs =
    source === 'global' ? globalPlansDir() : resolve(worktreePath, plansDir);

  // Canonicalise the dir via realpath so a symlinked `~/.claude` (or
  // worktree path) can't be flipped between calls to point at an
  // out-of-bounds location.
  let realDir: string;
  try {
    realDir = await realpath(dirAbs);
  } catch {
    return null;
  }

  const candidate = resolve(realDir, filename);
  let realFile: string;
  try {
    realFile = await realpath(candidate);
  } catch {
    return null;
  }
  // Defense in depth: even though SAFE_FILENAME_RE forbids slashes, assert
  // the canonical resolved path is still inside the canonical plans dir.
  if (!realFile.startsWith(realDir + sep)) {
    throw new Error('invalid_filename');
  }

  let md: string;
  try {
    md = await readFile(realFile, 'utf8');
  } catch {
    return null;
  }

  const html = renderPlanMarkdownToHtml(md);
  return { name: filename, html, markdown: md };
}

/**
 * Pure render path: markdown string → sanitized HTML. Exported so the
 * task-plan endpoint can render `queue_entries.plan_md` with the exact same
 * pipeline as the on-disk agent plans without re-implementing the marked +
 * DOMPurify hardening.
 */
export function renderPlanMarkdownToHtml(md: string): string {
  const rawHtml = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    // Strip anything that could exfil data on click/load. DOMPurify's
    // default html profile already drops <script>, but inline event
    // handlers and `javascript:` URLs need explicit hardening.
    FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload', 'onmouseover'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form']
  });
}
