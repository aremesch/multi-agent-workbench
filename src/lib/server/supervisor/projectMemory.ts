/**
 * Project memory — the repo-scoped "lessons learned" store the supervisor
 * maintains so recurring issue classes stop recurring across steps and runs.
 *
 * Pure bookkeeping (no LLM):
 *   - recordVerdictIssues(): after a QC verdict, fold its issues into
 *     project_memory keyed by (repo, category). Repeat hits upsert-increment.
 *   - renderLessons(): format active lessons for injection into a task / QC
 *     agent prompt.
 */

import { ulid } from 'ulid';
import { listProjectMemory, upsertProjectMemory } from '../db/queries.js';
import type { QcIssue } from './llm.js';

/**
 * Fold the issues from a QC verdict into the repo's project memory. Only
 * medium/high severity issues are persisted as lessons — low-severity nits
 * aren't worth nagging future agents about. The `lesson` is a short rule; the
 * `detail` keeps the most recent concrete example.
 */
export function recordVerdictIssues(opts: {
  userId: string;
  repoId: string;
  runId: string;
  issues: QcIssue[];
}): void {
  for (const issue of opts.issues) {
    if (issue.severity === 'low') continue;
    upsertProjectMemory({
      mintId: () => ulid(),
      user_id: opts.userId,
      repo_id: opts.repoId,
      category: issue.category.trim().toLowerCase() || 'general',
      lesson: `Avoid ${issue.category} issues — ${issue.detail}`.slice(0, 300),
      detail: issue.detail.slice(0, 1000),
      source_run_id: opts.runId
    });
  }
}

/**
 * Active lessons for a repo, rendered as short bullet strings suitable for
 * folding into an agent prompt. `minHits` lets the caller require a lesson to
 * have recurred before it's injected (default 1 = inject everything active).
 */
export function renderLessons(repoId: string, minHits = 1): string[] {
  return listProjectMemory(repoId, true)
    .filter((row) => row.hit_count >= minHits)
    .map((row) => (row.hit_count > 1 ? `${row.lesson} (seen ${row.hit_count}×)` : row.lesson));
}
