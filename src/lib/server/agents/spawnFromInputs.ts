/**
 * Shared spawn pipeline used by:
 *   - the synchronous spawn form action (`/agents/new/+page.server.ts`)
 *   - the queue API (`/api/queue` POST / PUT — uses `validateSpawnInputs` only)
 *   - the queue scheduler tick (`src/lib/server/queue/Scheduler.ts` — uses both
 *     `validateSpawnInputs` and `performSpawn` to promote an entry)
 *
 * The two halves are deliberately decoupled. Validation may run at save time
 * (queue insert) and again at promote time (just before the agent spawns) so
 * the queue can reject an entry whose role or repo was deleted in between.
 * The performer does I/O (git worktree, tmux, DB writes) and assumes its
 * inputs are already canonical.
 *
 * Error returns are discriminated codes (not human strings) so each caller
 * maps them to its own i18n keys — the form action picks `spawn.error.*`
 * keys, the queue API surfaces them as JSON, the scheduler stores them in
 * `queue_entries.last_error`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { getConfig } from '../config.js';
import {
  findWorktreeByPath,
  getProject,
  getRepo,
  getRole,
  insertTask,
  insertWorktree,
  updateAgentCurrentTask
} from '../db/queries.js';
import type { RepoRow, RoleRow } from '../db/types.js';
import { resolveSha } from '../git/agentCommits.js';
import { WorktreeManager } from '../git/WorktreeManager.js';
import { parseBrowserTargetUrl } from '../../shared/browserTarget.js';
import { slugifyTitle } from '../util/slug.js';
import {
  AgentSupervisor,
  isBrowserKind,
  type SpawnAgentArgs
} from './AgentSupervisor.js';
import type { AdapterListing, AdapterRegistry } from './adapters/AdapterRegistry.js';
import { sanitizeCapabilityValue } from './adapters/capabilityValidation.js';

/** Raw, untyped inputs from a form / JSON request. Whitespace already trimmed
 *  by the caller — string fields are passed through. Three-state flags
 *  (`with_worktree`) use `null` for absent. */
export interface RawSpawnInputs {
  roleId: string;
  repoId: string;
  taskTitle: string;
  taskBody: string;
  targetUrl: string;
  branch: string;
  withWorktreeExplicit: boolean | null;
  model: string | null;
  permissionMode: string | null;
  optionalArgs: Record<string, boolean>;
}

/** Fully validated + canonicalized inputs ready for `performSpawn`. */
export interface ValidatedSpawnInputs {
  role: RoleRow;
  repo: RepoRow;
  adapter: AdapterListing;
  title: string;
  body: string;
  /** Browser-kind only. Parsed and bound from `targetUrl`. */
  browser: { target_url: string; target_port: number } | null;
  /** Resolved per-spawn picks, already coerced through capability validation
   *  so unknown / stale ids land as null. The supervisor falls back to role
   *  defaults from there. */
  model: string | null;
  permissionMode: string | null;
  optionalArgs: Record<string, boolean>;
  /**
   * Whether to create a fresh worktree for this spawn. Three-state collapse:
   *   - false: adapter has createWorktree=false (browser, shell) — never a
   *     worktree, run in repo root
   *   - true: adapter supports worktrees AND the user didn't opt out
   *   - false: adapter supports worktrees AND the user opted out — run in
   *     repo root on `branchStartPoint`
   */
  shouldCreateWorktree: boolean;
  /**
   * Whether this adapter is even capable of creating a worktree. Distinct
   * from `shouldCreateWorktree`: a git-enabled adapter may still run in repo
   * root if the user unchecks the box.
   */
  adapterSupportsWorktree: boolean;
  /** The branch the worktree is created from (or the branch the agent runs
   *  on in repo root when worktree creation is off). */
  branchStartPoint: string;
  /** Filesystem-safe slug derived from the title; reused as the worktree dir
   *  name and as the seed for `nextFreeBranchName`. */
  slug: string;
}

/** Discriminated error codes — callers map these to their own i18n. */
export type SpawnErrorCode =
  | 'roleRepoRequired'
  | 'titleRequired'
  | 'titleUnslugifiable'
  | 'unknownRole'
  | 'unknownRepo'
  | 'unknownAdapter'
  | 'browserUrlEmpty'
  | 'browserUrlInvalid'
  | 'browserUrlScheme'
  | 'browserUrlHost'
  | 'browserUrlPort'
  | 'titleTaken'
  | 'branchMissing'
  | 'worktreeFailed'
  | 'spawnFailed';

export interface SpawnError {
  code: SpawnErrorCode;
  /** Extra context for codes that need it (e.g. error message from git). */
  message?: string;
}

/**
 * Validate raw inputs against the current DB and adapter registry. Pure
 * (modulo DB reads) — does not touch the filesystem, git, tmux, or the
 * supervisor. Safe to call in the queue API POST handler.
 *
 * If `verifyBranchExists` is true, calls `WorktreeManager.listBranches` on
 * the repo path and rejects with `branchMissing` when the requested branch
 * isn't there. Off by default because list-branches is a git subprocess —
 * the form action validates on submit, the queue API skips it (the user
 * picked from a dropdown of branches that existed when the dialog opened),
 * and the scheduler tick passes `true` because branches can disappear
 * between save and promote.
 */
export async function validateSpawnInputs(
  raw: RawSpawnInputs,
  userId: string,
  registry: AdapterRegistry,
  opts: { verifyBranchExists?: boolean } = {}
): Promise<{ ok: true; value: ValidatedSpawnInputs } | { ok: false; error: SpawnError }> {
  if (!raw.roleId || !raw.repoId) {
    return { ok: false, error: { code: 'roleRepoRequired' } };
  }
  const title = raw.taskTitle.trim();
  if (!title) return { ok: false, error: { code: 'titleRequired' } };
  const slug = slugifyTitle(title);
  if (!slug) return { ok: false, error: { code: 'titleUnslugifiable' } };

  const role = getRole(raw.roleId);
  if (!role || role.user_id !== userId) {
    return { ok: false, error: { code: 'unknownRole' } };
  }
  const repo = getRepo(raw.repoId);
  if (!repo || repo.user_id !== userId) {
    return { ok: false, error: { code: 'unknownRepo' } };
  }

  const adapter = registry.list().find((a) => a.kind === role.cli_kind);
  if (!adapter) {
    return { ok: false, error: { code: 'unknownAdapter' } };
  }

  let browser: ValidatedSpawnInputs['browser'] = null;
  if (isBrowserKind(role.cli_kind)) {
    const parsed = parseBrowserTargetUrl(raw.targetUrl);
    if (!parsed.ok) {
      const map: Record<string, SpawnErrorCode> = {
        empty: 'browserUrlEmpty',
        invalid: 'browserUrlInvalid',
        scheme: 'browserUrlScheme',
        host: 'browserUrlHost',
        port: 'browserUrlPort'
      };
      return {
        ok: false,
        error: { code: map[parsed.error] ?? 'browserUrlEmpty' }
      };
    }
    browser = { target_url: parsed.url, target_port: parsed.port };
  }

  const adapterSupportsWorktree = adapter.createWorktree;
  const shouldCreateWorktree =
    adapterSupportsWorktree && (raw.withWorktreeExplicit ?? adapterSupportsWorktree);

  const branchStartPoint =
    raw.branch ||
    repo.default_branch ||
    (repo.project_id ? getProject(repo.project_id)?.default_branch : null) ||
    'main';

  if (opts.verifyBranchExists && adapterSupportsWorktree) {
    try {
      const { branches } = await WorktreeManager.listBranches(repo.path);
      if (!branches.includes(branchStartPoint)) {
        return {
          ok: false,
          error: { code: 'branchMissing', message: branchStartPoint }
        };
      }
    } catch (err) {
      return {
        ok: false,
        error: { code: 'worktreeFailed', message: (err as Error).message }
      };
    }
  }

  // Capability sanitization. Unknown / removed ids fall back to null; the
  // supervisor then resolves role default → adapter default.
  const model = sanitizeCapabilityValue(adapter.capabilities.model, raw.model);
  const permissionMode = sanitizeCapabilityValue(
    adapter.capabilities.permissionMode,
    raw.permissionMode
  );

  // Body only applies when the adapter takes an initial prompt at all.
  const body = adapter.initialInputDelivery === 'cli-arg' ? raw.taskBody : '';

  return {
    ok: true,
    value: {
      role,
      repo,
      adapter,
      title,
      body,
      browser,
      model,
      permissionMode,
      optionalArgs: raw.optionalArgs,
      shouldCreateWorktree,
      adapterSupportsWorktree,
      branchStartPoint,
      slug
    }
  };
}

/**
 * Execute the worktree / spawn / task pipeline for already-validated inputs.
 *
 * Mirrors what `/agents/new/+page.server.ts` did before extraction:
 *   1. Create worktree (or check out branch in repo root, or run in repo root
 *      as-is for non-git adapters)
 *   2. Insert worktree row
 *   3. Call supervisor.spawn (which inserts the agent row)
 *   4. Insert task row + link to agent via `current_task_id`
 *
 * Returns the spawned agent id on success.
 */
export async function performSpawn(
  v: ValidatedSpawnInputs,
  userId: string,
  supervisor: AgentSupervisor
): Promise<{ ok: true; agentId: string } | { ok: false; error: SpawnError }> {
  const cfg = getConfig();
  const wtm = new WorktreeManager(cfg.worktreeRoot);
  const agentId = ulid();

  let worktreePath: string;
  let worktreeBranch: string;
  let baseSha: string | null = null;

  if (v.shouldCreateWorktree) {
    const targetPath = join(cfg.worktreeRoot, v.slug);
    if (findWorktreeByPath(targetPath) || existsSync(targetPath)) {
      return { ok: false, error: { code: 'titleTaken' } };
    }
    let resolvedBranch: string;
    try {
      resolvedBranch = await WorktreeManager.nextFreeBranchName(v.repo.path, v.slug);
    } catch (err) {
      return {
        ok: false,
        error: { code: 'worktreeFailed', message: (err as Error).message }
      };
    }
    try {
      const created = await wtm.create({
        repoPath: v.repo.path,
        agentId,
        branch: resolvedBranch,
        startPoint: v.branchStartPoint,
        dirName: v.slug
      });
      worktreePath = created.path;
      baseSha = created.baseSha;
    } catch (err) {
      return {
        ok: false,
        error: { code: 'worktreeFailed', message: (err as Error).message }
      };
    }
    worktreeBranch = resolvedBranch;
  } else if (v.adapterSupportsWorktree) {
    // Worktree opted out on a git-enabled adapter: check out the picked
    // branch in the repo root and let the agent run there.
    try {
      await WorktreeManager.checkout(v.repo.path, v.branchStartPoint);
    } catch (err) {
      return {
        ok: false,
        error: { code: 'worktreeFailed', message: (err as Error).message }
      };
    }
    worktreePath = v.repo.path;
    worktreeBranch = v.branchStartPoint;
    baseSha = await resolveSha(v.repo.path, v.branchStartPoint);
  } else {
    // Adapter has createWorktree=false (browser, shell): run directly in
    // the repo root on whatever branch is already checked out. No
    // throwaway branch, no slug/targetPath collision check.
    worktreePath = v.repo.path;
    worktreeBranch = v.branchStartPoint;
    baseSha = await resolveSha(v.repo.path, v.branchStartPoint);
  }

  const worktreeId = ulid();
  insertWorktree({
    id: worktreeId,
    user_id: userId,
    repo_id: v.repo.id,
    path: worktreePath,
    branch: worktreeBranch,
    status: 'active'
  });

  const spawnArgs: SpawnAgentArgs = {
    agentId,
    userId,
    roleId: v.role.id,
    repoId: v.repo.id,
    repoPath: v.repo.path,
    worktreeId,
    worktreePath,
    baseSha,
    task: { title: v.title, body: v.body },
    optionalArgs: v.optionalArgs,
    model: v.model,
    permissionMode: v.permissionMode,
    sourceBranch: worktreeBranch
  };
  if (v.browser) spawnArgs.browser = v.browser;

  try {
    await supervisor.spawn(spawnArgs);
  } catch (err) {
    return {
      ok: false,
      error: { code: 'spawnFailed', message: (err as Error).message }
    };
  }

  // Task row exists so dashboard / queue UI can show the prompt body even
  // after the agent moves into the archive. The agent row is already in
  // place (insertAgent ran inside supervisor.spawn).
  const taskId = ulid();
  insertTask({
    id: taskId,
    user_id: userId,
    agent_id: agentId,
    title: v.title,
    body: v.body,
    status: 'active',
    assigned_by_agent_id: null
  });
  updateAgentCurrentTask(agentId, taskId);

  return { ok: true, agentId };
}
