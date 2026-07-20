# Show Changes — mobile-friendly agent diff viewer with AI Q&A

> **First step after approval:** `git mv docs/plans/the-user-shall-be-goofy-parrot.md docs/plans/feat-diff-changes.md`
> (plan name must match the `feat-diff-changes` branch/worktree per repo conventions).

## Context

Users need a quick overview of what an agent has changed in its worktree/branch —
especially from the phone PWA, where reviewing a raw `git diff` in the terminal is
painful. This adds a **"Show Changes"** entry to the agent dialog's kebab menu
(alongside the existing "Show Plan" / "Show Log"), opening a modal that renders the
agent's diff in a smartphone-optimized layout. To help non-experts understand the
change set, the same dialog offers an **on-demand AI Q&A panel**: the diff renders
instantly for free, and the user can type questions about the changes that are sent,
with the diff as context, to an LLM.

Confirmed scope decisions (from the user):
- **AI = on-demand Q&A only** (no auto-generated summary; zero LLM cost to open the dialog).
- **Diff shown as two sections** — "Committed" (`base_sha..HEAD`) and "Uncommitted" (working tree) — kept visually separate.
- **AI credential prefers `CLAUDE_CODE_OAUTH_TOKEN`**, falls back to `ANTHROPIC_API_KEY`; the Q&A panel is gracefully disabled (with a hint) when neither is set.

This is MAW's **first direct LLM call** — every agent today is an interactive tmux
TUI; there is no existing prompt→completion path to reuse.

## Approach

Mirror the existing "Show Plan" vertical exactly — one new file per layer — plus a
small new `llm/` module. The pattern to clone is the trio
`PlanViewerModal.svelte` + `routes/api/agents/[id]/plan/+server.ts` +
`lib/server/plans/agentPlans.ts`.

| Layer | New file | Clones |
|---|---|---|
| Git diff helper | `src/lib/server/git/agentDiff.ts` | `git/worktreeStatus.ts`, `plans/agentPlans.ts` git usage |
| Read route | `src/routes/api/agents/[id]/changes/+server.ts` | `plan/+server.ts` auth guard |
| Q&A route | `src/routes/api/agents/[id]/changes/qa/+server.ts` | new |
| LLM module | `src/lib/server/llm/{index,anthropic,prompt}.ts` | new |
| Modal | `src/lib/client/components/ShowChangesModal.svelte` | `PlanViewerModal.svelte` |
| Wiring | edits to `AgentMenu.svelte`, `AgentWindowModal.svelte`, `repos/[id]/archive/+page.svelte`, `i18n/{en,de,es,fr}.ts` | — |

### 1. Mobile diff formatting — parse on the server, ship structured JSON

Parse the unified diff **server-side** (we already run in Node beside git) and send
structured JSON, not a raw patch blob. This lets the phone lazily build hunk DOM on
expand, compute stat badges without re-parsing, and lets the server enforce size caps
before anything crosses the wire. Wire contract (defined in `agentDiff.ts`):

```ts
type ChangeStatus = 'A'|'M'|'D'|'R'|'C'|'T';
type DiffLineType = 'context'|'add'|'del';
interface DiffLine { type: DiffLineType; oldNo: number|null; newNo: number|null; text: string } // text has NO leading +/-/space
interface DiffHunk { header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] }
interface DiffFile { path: string; oldPath: string|null; status: ChangeStatus; added: number; removed: number; binary: boolean; hunks: DiffHunk[]; truncated: boolean } // added/removed = -1 when binary
interface DiffSection { kind: 'committed'|'uncommitted'; files: DiffFile[]; totalAdded: number; totalRemoved: number; truncated: boolean; note: string|null } // note: 'base_unavailable'|'worktree_gone'|'no_commits'|null
interface ChangesResponse { committed: DiffSection; uncommitted: DiffSection; baseSha: string|null; headSha: string|null; aiEnabled: boolean }
```

**Smartphone rendering** (in `ShowChangesModal.svelte`):
- Two top-level collapsible sections ("Committed" / "Uncommitted"), each `<details>`
  with a summary showing file count + aggregate `+N / −M`. Both collapsed by default.
- Per-file **cards, collapsed by default**: status chip (`A/M/D/R`) + path + `+added/−removed`
  badges. Long paths use `direction: rtl; text-overflow: ellipsis` so the basename stays visible.
- **Unified single-column hunks** (never side-by-side). Each hunk is its own
  `<pre class="hunk">` with `overflow-x: auto`; the diff body is `overflow-x: hidden`
  so horizontal scroll is confined to a hunk and the page body never scrolls sideways.
- Two narrow gutter columns (old/new line no) + a sign column, so **color is never the
  only signal** (accessibility + theme safety). Add/del use semi-transparent tints over
  the dark base (add `rgba(46,160,67,0.15)` + left border `#2ea043`; del
  `rgba(248,81,73,0.15)` + `#f85149`), monospace ~0.72rem.
- **Lazy hunk DOM**: gate hunk rendering on an explicit per-card `expanded` state
  (`{#if expanded}`), not just `<details>` — Svelte renders `<details>` children even
  when closed, so a 400-file diff would otherwise build all DOM up front.

**Large-diff / binary (all decided server-side):** per-file cap (~1,500 lines / ~200KB →
`truncated: true`, drop hunks, keep stats, card shows "Large change — stats only");
total section byte cap (~2MB → stop emitting hunks for remaining files, `section.truncated`);
binary files (`numstat` `-\t-`) → `binary: true`, `added/removed = -1`, no hunks.

### 2. Git helper — `src/lib/server/git/agentDiff.ts`

Uses `getGit(worktreePath)` from `git/client.ts`. Exports
`getAgentChanges(worktreePath, baseSha)` plus `getCommittedDiff` / `getUncommittedDiff`,
and a pure, unit-testable `parseUnifiedDiff(patch): DiffFile[]` + `mergeNumstat(files, numstat)`.

- **Committed (`base_sha..HEAD`)**: guard the base exactly like `agentPlans.touchedFiles`
  (`git.revparse(['--verify', \`${baseSha}^{commit}\`])`; on throw or `baseSha == null` →
  empty section, `note: 'base_unavailable'`). Patch via
  `git.diff(['--patch','-M','--no-color', \`${baseSha}..HEAD\`])`; counts + binary flags via
  `git.diff(['--numstat','-M', \`${baseSha}..HEAD\`])`. Status derived from extended header lines.
- **Uncommitted**: tracked via `git.diff(['--patch','-M','--no-color','HEAD'])` (+ `--numstat`);
  untracked from `git.status()` (established pattern in `worktreeStatus.ts`), each rendered as
  an all-add file via `git.diff(['--no-index','--','/dev/null', path])`.
- **Failure modes**: worktree dir gone → both sections empty, `note: 'worktree_gone'`
  (route returns 200 so the UI shows a friendly message).

### 3. Routes

- **`GET /api/agents/[id]/changes`** — auth guard identical to `plan/+server.ts`
  (`401` no user, `404` missing agent, `403` wrong owner, `getWorktree(agent.worktree_id)` → `404`).
  Returns `ChangesResponse` with `aiEnabled: llm.isConfigured()`. Bare `fetch` on the client (GET, no CSRF).
- **`POST /api/agents/[id]/changes/qa`** — same auth guard; CSRF via existing `apiFetch`.
  Request `{ question, sections: ('committed'|'uncommitted')[], history?: {q,a}[] }` →
  response `{ html }`. **Re-derives the diff server-side** via `getAgentChanges` (stateless;
  the phone never re-uploads the diff — only the small question + history cross the wire),
  builds the prompt, calls `llm.answer`, renders with `renderPlanMarkdownToHtml` (reused from
  `agentPlans.ts`). Errors: `503 {code:'ai_unconfigured'}`, `400 {code:'invalid_question'}`,
  `502 {code:'llm_error'}`.

### 4. LLM module — `src/lib/server/llm/`

New dependency: **`@anthropic-ai/sdk`** (justified: handles the OAuth-Bearer vs API-key
header split, retries, typed errors — hand-rolling `fetch` would re-implement exactly the
auth nuance this depends on). `index.ts` (facade + provider selection), `anthropic.ts`,
`prompt.ts`.

- **Auth (prefer OAuth, fall back to key)** — reads `getConfig()` (`claudeCodeOauthToken`,
  `anthropicApiKey` already on `MawConfig`; **no config-code change**, only an `.env.example` note):
  ```ts
  if (claudeCodeOauthToken)
    return new Anthropic({ authToken: claudeCodeOauthToken,
                           defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } });
  if (anthropicApiKey) return new Anthropic({ apiKey: anthropicApiKey });
  return null;
  ```
  (`authToken` makes the SDK send `Authorization: Bearer`; the `oauth-2025-04-20` beta header
  is required for `/v1/messages` with a Claude Code OAuth token.) `isConfigured()` returns
  `Boolean(claudeCodeOauthToken || anthropicApiKey)`.
- **Minimal provider seam**: `LlmProvider { isConfigured(); answer(req): Promise<string> }`.
  OpenAI/Gemini slot in later as sibling files behind a future `MAW_LLM_PROVIDER` — nothing else changes.
- **The call** — `client.messages.create({ model: 'claude-opus-4-8', max_tokens: 2048, system, messages: [{role:'user', content}] })`.
  Short answer → non-streaming + modest `max_tokens` is safe (well under timeout; no streaming/thinking config).
- **Prompt** (`prompt.ts`): system = "You are a code reviewer explaining a git diff to the
  repository owner. Answer only from the diff provided; if it isn't there, say so. Respond in
  concise Markdown." User = selected section(s) rendered back to fenced unified-diff text +
  prior history Q/A + the question last. **Size budget**: cap embedded diff by a ~4-char/token
  heuristic targeting ~40k tokens (~160k chars), truncating trailing hunks per-file with a
  `[diff truncated for length]` marker.

### 5. Frontend — `ShowChangesModal.svelte`

Clone `PlanViewerModal.svelte`: `{ open, agentId, onClose }` props, memo-gated `$effect`
fetching `/api/agents/{id}/changes` (bare `fetch`) only when opened for a new agentId, same
`loading | empty | error` states and styling. Body = the two sections + per-file cards (§1).
Q&A panel at the bottom = a `<textarea>` + Send that POSTs via `apiFetch`; Q/A pairs live in
**ephemeral component `$state`** and render via `{@html}` (server-sanitized). When
`aiEnabled === false`, disable the input with a hint ("Set `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY` to enable Q&A"); the `503 ai_unconfigured` is a defensive backstop.

**Wiring edits:**
- `AgentMenu.svelte`: add optional `onShowChanges?` prop + a `{ id:'changes', label:
  t('agentMenu.showChanges'), icon: changesIcon, onSelect: onShowChanges, disabled: planDisabled }`
  item (reuse the existing coding-kind gate) + a `changesIcon` snippet.
- `AgentWindowModal.svelte`: `changesOpen = $state(false)`, `openShowChanges()`, pass
  `onShowChanges` to `<AgentMenu>`, render `{#if changesOpen}<ShowChangesModal/>{/if}`, and add
  `changesOpen = false` to the existing teardown `$effect`.
- `repos/[id]/archive/+page.svelte`: **parallel edit** (uses `AgentMenu` directly, not via
  `AgentWindowModal`) — add `onShowChanges` + a `<ShowChangesModal>` instance for parity.
  Secondary; ship the live path first.
- `i18n/{en,de,es,fr}.ts`: add `agentMenu.showChanges` and a `changes.modal.*` block (title,
  loading, empty, error, retry, committed, uncommitted, binary, largeChange, askPlaceholder,
  send, aiDisabledHint) across all four locales.

### 6. Persistence

**No DB migration.** Q&A stays ephemeral in component state — no persistence requirement
(on-demand, not a saved conversation), avoids a schema/query surface, and keeps diffs +
questions out of the DB (privacy). A `changes_qa` table can be added later if wanted; nothing here blocks it.

## Key edge cases / risks

1. **`git diff --no-index` exits non-zero on differences** → simple-git throws; recover the
   patch from the thrown error's stdout, or degrade the untracked file to stat-only. Fiddliest part.
2. **Unborn HEAD** (worktree with no commits): both `base_sha..HEAD` and `diff HEAD` fail →
   fall back to the empty-tree sentinel `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, `note: 'no_commits'`.
3. **Rename/copy** (`-M`): numstat keys by the *new* path — merge carefully or counts won't attach.
4. **Size caps are load-bearing**, not optional — a large refactor could OOM the JSON serialize / freeze the phone.
5. **OAuth token expiry/revocation** → surfaces as `502 llm_error`; UI shows the message, not a blank panel. No refresh logic in scope.
6. **`\ No newline at end of file` / CRLF** must be tolerated by the parser or line numbering drifts.
7. **Prompt injection via diff content** is low-risk (owner's own worktree) and the answer is
   still routed through `renderPlanMarkdownToHtml`'s DOMPurify hardening.

## Tests (mirror existing suites)

- `src/lib/server/git/agentDiff.test.ts` — real temp git repo (`fs.mkdtemp` → `getGit` → init →
  base commit → extra commits → dirty tree with a modified tracked file + an untracked file).
  Assert committed counts/status/rename, uncommitted covers tracked + untracked, binary →
  `binary:true, added:-1`, missing base → `note:'base_unavailable'`. Plus pure `parseUnifiedDiff`
  unit tests on canned patches (rename, delete, `\ No newline`).
- `src/routes/api/agents/[id]/changes/server.test.ts` — clone `plan/server.test.ts`: mock
  queries + `agentDiff` + `llm`; assert 401/404/403, worktree-missing, response shape, `aiEnabled`.
- `src/routes/api/agents/[id]/changes/qa/server.test.ts` — 401/403/404, `503 ai_unconfigured`,
  `400 invalid_question`, success `{ html }` (mock `llm.answer` + `renderPlanMarkdownToHtml`).
- `src/lib/client/components/ShowChangesModal.test.ts` — clone `PlanViewerModal.test.ts` (jsdom,
  `fetch` + `apiFetch` + `useT` stubs): both sections render, cards collapsed by default (hunks
  absent until expand), expand reveals lines, disabled-AI hint shows, Q&A round-trip renders HTML.

## Verification (end-to-end)

1. `pnpm install` (picks up `@anthropic-ai/sdk`), then `pnpm test` — new suites green, existing pass.
2. `pnpm lint` / typecheck clean.
3. Run the app (`/run` or the project's dev command). Spawn an agent, have it make a commit and
   leave an uncommitted edit in its worktree. Open the agent dialog → kebab → **Show Changes**:
   verify both sections render, cards collapse/expand, no horizontal page scroll on a narrow
   (≤400px) viewport, binary/large-file states.
4. With `CLAUDE_CODE_OAUTH_TOKEN` set: ask a question in the Q&A panel → a sanitized Markdown
   answer renders. Unset both credentials → panel is disabled with the hint.
5. PWA check: install the PWA on a phone (or emulate mobile in devtools) and confirm the layout
   is legible and scroll-safe.
