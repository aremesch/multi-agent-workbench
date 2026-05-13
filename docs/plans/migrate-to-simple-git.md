# Migrate git access to `simple-git`

## Context

The trigger for this work was a parsing bug in [src/lib/server/plans/agentPlans.ts:185](src/lib/server/plans/agentPlans.ts:185) and [:211](src/lib/server/plans/agentPlans.ts:211): both `git diff -z` and `git status -z` outputs are split on `' '` instead of `'\0'`. With `-z`, real git emits NUL-separated paths, so the touched-plan filter currently returns an empty set — meaning agents with a `base_sha` see **no plans** in the kebab menu. The mocked stdout in [agentPlans.test.ts](src/lib/server/plans/agentPlans.test.ts) uses spaces too, which is why CI never caught it.

Rather than swap two characters and move on, we're using the bug as the prompt to convert all git access in `src/lib/server/` from `execa('git', [...])` + manual stdout parsing to the [`simple-git`](https://github.com/steveukx/git-js) library. Wins:

- **No more manual `-z` splits.** simple-git owns parsing for `status` / `diff` / `log` and returns structured TypeScript objects (`StatusResult`, `DiffResult`, `LogResult<T>`). The class of bug this plan was born from disappears.
- **Typed errors.** `GitError` / `GitResponseError<T>` with stderr on `.message` replaces our ad-hoc `try { … } catch (e: unknown) { … }` shape.
- **Consistent cwd handling.** `simpleGit(cwd)` replaces `-C <cwd>` arg-prepending everywhere.

Trade-off the user has acknowledged: simple-git has no first-class `worktree` methods (issues [#1096](https://github.com/steveukx/git-js/issues/1096), [#340](https://github.com/steveukx/git-js/issues/340) closed without API). All `git worktree …` calls in [WorktreeManager.ts](src/lib/server/git/WorktreeManager.ts) go through `git.raw(['worktree', …])`. We still gain the unified cwd handling, mocking surface, and `GitError` typing — we just hand-roll the parser for `worktree list --porcelain` (already a custom parser, no change there).

The original bug (`agentPlans.ts` filter) is fixed as a natural consequence of replacing those two manual splits with `git.status(...)` / `git.diff(...)` calls.

## Scope

7 source files, 5 test files. The integration test [agentCommits.reachability.integration.test.ts](src/lib/server/git/agentCommits.reachability.integration.test.ts) shells real git via execa to build fixture repos — that stays untouched.

| Source file | Calls | Migration kind |
|---|---|---|
| [src/lib/server/git/clone.ts](src/lib/server/git/clone.ts) | 1 | `.clone(url, path, opts)` with `simpleGit({ env, timeout })`; preserve auth-error keyword mapping via catch on `GitError.message` |
| [src/lib/server/git/agentCommits.ts](src/lib/server/git/agentCommits.ts) | ~10 | `.revparse()`, `.log()` w/ custom format, `.raw(['merge-base', …])`, `.raw(['cat-file', …])`, `.raw(['for-each-ref', …])`; keep `\x1e`/`\x1f` log format + `parseLog()` |
| [src/lib/server/git/WorktreeManager.ts](src/lib/server/git/WorktreeManager.ts) | 13 | `.raw(['worktree', …])` for worktree subcommands; `.revparse()`, `.status()`, `.init()`, `.commit()`, `.raw(['symbolic-ref', …])`, `.raw(['branch', '-m', …])` for the rest |
| [src/lib/server/git/worktreeStatus.ts](src/lib/server/git/worktreeStatus.ts) | 1 | `.status()` returns `StatusResult.files: FileStatusResult[]`; drop manual `-z`/slice |
| [src/lib/server/plans/agentPlans.ts](src/lib/server/plans/agentPlans.ts) | 3 | `.revparse(['--verify', `${baseSha}^{commit}`])`, `.diff(['--name-only', '--diff-filter=AM', `${baseSha}..HEAD`, '--', plansDir])` (newline-split — `-z` no longer needed), `.status([plansDir])` returning `FileStatusResult[]`. **Fixes the original bug.** |
| [src/routes/api/repos/+server.ts](src/routes/api/repos/+server.ts) | 1 | `.revparse(['--git-dir'])` |
| [src/routes/projects/[id]/repos/new/+page.server.ts](src/routes/projects/[id]/repos/new/+page.server.ts) | 1 | `.revparse(['--git-dir'])` |

## Approach

### 1. Add the dependency

```bash
pnpm add simple-git
```

simple-git is a Node-only `child_process` wrapper, ~140 KB installed, 5 small runtime deps, ~9.5M weekly downloads, monthly releases (current `3.36.0`, May 2026). No native binaries.

### 2. Introduce a thin factory — `src/lib/server/git/client.ts` (new file)

A single entry point so the rest of the codebase doesn't import `simple-git` directly. Centralises cwd, timeout, and env handling, and gives tests a single seam to mock.

```ts
import simpleGit, { type SimpleGit, type SimpleGitOptions } from 'simple-git';

export function getGit(cwd?: string, overrides?: Partial<SimpleGitOptions>): SimpleGit {
  return simpleGit({
    baseDir: cwd,
    binary: 'git',
    maxConcurrentProcesses: 6,
    ...overrides
  });
}

export { GitError, GitResponseError } from 'simple-git';
```

For `clone.ts`, callers pass the timeout + env overrides (`{ GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' }`) through `overrides`.

### 3. Migrate files in dependency order

Recommended ordering — each step is a green-tests checkpoint, then commit:

1. **Add dep + `client.ts`** — no code uses it yet.
2. **[+server.ts](src/routes/api/repos/+server.ts) + [+page.server.ts](src/routes/projects/[id]/repos/new/+page.server.ts)** — 1 call each, both `rev-parse --git-dir`. Smallest possible migration; validates the factory and test-mocking pattern.
3. **[worktreeStatus.ts](src/lib/server/git/worktreeStatus.ts)** — 1 call. Drop the `-z` parsing entirely; `git.status()` returns structured `files`.
4. **[agentPlans.ts](src/lib/server/plans/agentPlans.ts)** — 3 calls. **This closes the original bug.** Also update the test mocks to mock simple-git instead of execa.
5. **[WorktreeManager.ts](src/lib/server/git/WorktreeManager.ts)** — heaviest worktree user. Each `git worktree` call → `git.raw(['worktree', …])`. Keep the existing `worktree list --porcelain` block parser as-is.
6. **[agentCommits.ts](src/lib/server/git/agentCommits.ts)** — heaviest log/refs user. Keep the `\x1e`/`\x1f` custom log format and existing `parseLog()` by passing the format string verbatim via `.raw(['log', '--pretty=format:…', …])` (or `.log({ format: { hash: '%H', … } })` if we want to drop `parseLog` — out of scope, keep the existing parser).
   - The `cat-file --batch-check` site (line 237) feeds stdin. simple-git's `.raw()` doesn't accept stdin directly; use the second-arg callback form `git.raw(args, (err, data) => …)` is also no help. **Fallback:** keep this one call on execa or use `simpleGit().outputHandler()` to pipe stdin. Decide during implementation; both are acceptable.
7. **[clone.ts](src/lib/server/git/clone.ts)** — last because of the env / timeout / auth-keyword shape. Use `simpleGit({ env, timeout: { block: timeoutMs } })`. Catch `GitError`; pattern-match `error.message` for the same keywords (`'permission denied'`, `'authentication failed'`, `'could not read username'`, `'host key verification failed'`) and map to existing `CloneError` codes. Behaviour-preserving.

### 4. Update test mocks

Each migrated file's test gets its `vi.mock('execa', …)` replaced with `vi.mock('$lib/server/git/client', () => ({ getGit: vi.fn(), … }))` (path alias adjusts if needed). Per-test, `getGit.mockReturnValue({ status: vi.fn().mockResolvedValue({ files: [...] }), … } as unknown as SimpleGit)`.

Mocking pattern — example for [agentPlans.test.ts](src/lib/server/plans/agentPlans.test.ts):

```ts
vi.mock('$lib/server/git/client', () => ({ getGit: vi.fn() }));

it('filters by git diff + status when base_sha resolves', async () => {
  vi.mocked(getGit).mockReturnValue({
    revparse: vi.fn().mockResolvedValue('BASE\n'),
    diff: vi.fn().mockResolvedValue('docs/plans/kept.md\n'),
    status: vi.fn().mockResolvedValue({
      files: [{ path: 'docs/plans/staged.md', index: '?', working_dir: '?' }]
    })
  } as unknown as SimpleGit);
  // …
});
```

Note that mocks no longer need to fake NUL bytes — simple-git's output is already structured, so the bug class can't recur in either source or tests.

[agentCommits.reachability.integration.test.ts](src/lib/server/git/agentCommits.reachability.integration.test.ts) keeps using real `execa('git', …)` for fixture setup — it's testing real git behaviour, not our wrapper.

### 5. Sweep

After migration, grep should turn up no remaining `execa('git'` calls in `src/lib/server/` (except possibly the one stdin case in `agentCommits.ts:237` and the integration-test fixtures). Verify:

```bash
rg "execa\(['\"]git" src/lib src/routes
```

## Critical files

- [src/lib/server/git/client.ts](src/lib/server/git/client.ts) — new factory, the single import point.
- [src/lib/server/plans/agentPlans.ts](src/lib/server/plans/agentPlans.ts) — closes the original bug.
- [src/lib/server/git/WorktreeManager.ts](src/lib/server/git/WorktreeManager.ts) — heaviest `.raw()` consumer; verify worktree add/remove/list still behave identically.
- [src/lib/server/git/clone.ts](src/lib/server/git/clone.ts) — env + timeout + auth-error mapping is the trickiest behaviour-preservation.
- [src/lib/server/git/agentCommits.ts](src/lib/server/git/agentCommits.ts) — custom log format + the one `cat-file --batch-check` stdin case.
- All 5 corresponding test files for mock rewrites.

## Verification

1. **Per-file** — after each migration step, run that file's test suite: `pnpm test src/lib/server/git/<file>.test.ts` (or for agentPlans, `pnpm test src/lib/server/plans/agentPlans.test.ts`). Each step lands with tests green before moving on.
2. **Full unit suite** — `pnpm test` to catch indirect breakage.
3. **Real-git integration** — `pnpm test src/lib/server/git/agentCommits.reachability.integration.test.ts` confirms no regression in code paths that exercise actual git.
4. **Type check** — `pnpm check`. `SimpleGit` typings flow through the new factory; expect a handful of `as unknown as SimpleGit` casts in tests.
5. **Manual smoke** — on dev server: (a) create a new repo via `/projects/[id]/repos/new` (exercises `revparse --git-dir`); (b) spawn an agent in a fresh worktree (exercises `WorktreeManager` add); (c) open the agent's kebab menu and confirm only branch-touched plans are listed (**this is the original bug repro — must now show the correct filtered list, not empty**); (d) delete the worktree (exercises worktree remove + prune).
6. **Negative-path manual** — clone an unreachable repo URL to confirm `CloneError` codes still map correctly (permission-denied → `auth_failed`, etc.).

## After approval

Per project conventions: rename the auto-generated plan file before starting implementation. Suggested: **`fix-migrate-to-simple-git`** (no version prefix — refactor outside the v0.x milestone track).

```bash
git mv docs/plans/while-reading-agentplans-ts-185-and-cryptic-hummingbird.md \
       docs/plans/fix-migrate-to-simple-git.md
```

Create a matching feature branch `fix/migrate-to-simple-git`. Commit in the per-file order above so reviewers can step through.
