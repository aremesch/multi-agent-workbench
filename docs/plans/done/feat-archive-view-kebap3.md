# Archive View — Kebab Menu Parity with Agent Dialog

## Context

Today the archive page (`/repos/[id]/archive`) only exposes **View Logs** as a button in each row's actions cell. The live agent dialog (`AgentWindowModal`) has a richer kebab menu (Show Plan / Show Log / Exit Agent) backed by `AgentMenu` → `OverflowMenu`. The user wants the same kebab in the archive view (replacing the standalone log button) so the two surfaces feel consistent and Show Plan becomes reachable for archived agents (their plans are still on disk until the row is deleted via the trash icon).

Decisions (from clarifying Q&A):

- Archive view kebab shows **Plan + Log only** — no Exit item (archived agents are by definition already exited; a perma-disabled row adds noise).
- Kebab renders for **every archived row** regardless of CLI kind. **Show Plan auto-disables** when the agent's `cli_kind` is not a coding kind (so Log still works for `browser`/`shell` agents and we avoid a regression).

## Approach

Reuse `AgentMenu` rather than introduce a parallel menu. Add a minimal opt-in to drop the Exit row and to disable Show Plan based on the CLI kind. Then swap the archive row's `View Logs` button for the kebab.

### 1. Extend `AgentMenu` (small, surgical)

File: `src/lib/client/components/AgentMenu.svelte`

- Add an optional prop: `showExit?: boolean` — defaults to `true` (preserves current callers and the existing parity test).
- Make Show Plan auto-disable when `!isCodingCliKind(agent.cli_kind)` (import from `$lib/shared/browserTarget`).
  - This is a no-op for the agent dialog because that call site already gates the whole `AgentMenu` on `isCodingCliKind`. It enables the archive caller to render the kebab uniformly without splitting the component.
- When `showExit === false`, omit the Exit item (and its `dividerBefore`) from the derived `items` array.
- Keep the `onExit` prop type unchanged but make it optional (it's never invoked when `showExit` is false). Existing callers continue passing it.

### 2. Wire the kebab into the archive page

File: `src/routes/repos/[id]/archive/+page.svelte`

- Import `AgentMenu` and `PlanViewerModal` (alongside the already-present `ArchivedAgentLogModal`).
- Replace the `<button class="view-btn">` (lines 195–197) with:
  ```svelte
  <AgentMenu
    agent={{ id: entry.agent.id, cli_kind: entry.agent.cli_kind, status: entry.agent.status }}
    showExit={false}
    onShowPlan={() => openPlan(entry)}
    onShowLog={() => viewLog(entry)}
    onExit={() => {}}
  />
  ```
- Add Plan-modal state alongside the existing log state:
  ```ts
  let planAgentId = $state<string | null>(null);
  function openPlan(entry) { planAgentId = entry.agent.id; }
  function closePlan()    { planAgentId = null; }
  ```
- Render `PlanViewerModal` at the bottom of the page (mirrors the existing `ArchivedAgentLogModal` render), using `source={{ kind: 'agent', agentId: planAgentId ?? '' }}` and `open={planAgentId !== null}`. The backend endpoint `/api/agents/[id]/plan` already serves on-disk plan files from the agent's worktree and works for archived agents until the row is deleted.
- Delete the now-unused `.view-btn` CSS block (lines 479–490). The kebab brings its own M3 trigger styling from `OverflowMenu`.
- Keep the **Refresh** and **Delete** icon-buttons next to the kebab (out of scope; they are not log/plan actions).

### Critical files to modify

- `src/lib/client/components/AgentMenu.svelte` — add `showExit` prop + plan-disabled logic.
- `src/routes/repos/[id]/archive/+page.svelte` — swap button for `AgentMenu`, add plan-modal state + render, drop `.view-btn` CSS.

### Reused, untouched

- `OverflowMenu.svelte` — the menu primitive (`align="end"`, `min-height: 48px` rows, M3 tokens).
- `PlanViewerModal.svelte` (`source: { kind: 'agent', agentId }`) — already supports any agent id; endpoint reads from the worktree on disk.
- `ArchivedAgentLogModal.svelte` — unchanged, just opened from the kebab instead of the button.
- i18n strings `agentMenu.button` / `agentMenu.showPlan` / `agentMenu.showLog` are already defined.

## Tests

- `AgentMenu.test.ts` is the parity gate — keep it green. Existing tests pass `showExit` as default (true). Add new cases:
  - When `showExit={false}`, the menu renders only 2 items and `agentMenu.exitAgent` is absent.
  - When `cli_kind` is non-coding (e.g. `browser`), the Show Plan item is rendered but `aria-disabled` / `disabled`.
- No new test file for the archive page; existing page tests (if any) should still pass — the `viewLog` handler is unchanged.

## Verification

1. `pnpm test` — unit tests, including the augmented `AgentMenu.test.ts`.
2. `pnpm dev` — open `/repos/[id]/archive`:
   - Each archived row now shows a kebab (⋮) in place of the green "View Logs" button.
   - Click kebab → **Show Plan** opens the plan viewer for that agent (verify with a row whose agent has a `docs/plans/*.md`); **Show Log** opens the existing log modal.
   - Verify no Exit row appears.
   - Verify Show Plan is greyed out on a `browser` or `shell` archived row, while Show Log still works.
3. Open an active agent's dialog elsewhere in the app and confirm its kebab is unchanged (Plan + Log + Exit).
4. Keyboard: open kebab with Enter, Escape closes and returns focus, items reachable by Tab — behaviour comes from `OverflowMenu` and should be unaffected.
