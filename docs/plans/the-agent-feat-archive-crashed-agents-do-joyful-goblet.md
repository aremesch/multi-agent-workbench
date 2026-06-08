# Fix: agent plan dropdown leaks unrelated global plans

## Context

The "Show Plan" modal for an agent (e.g. `feat-archive-crashed-agents`)
does not display that agent's own plan. Instead the dropdown offers a
handful of unrelated plans that are several days old and were authored
*before* the agent was spawned — in the reported case, plans from a
completely different project (`import-of-consorsbank-pdf-frolicking-haven.md`,
about Consorsbank transaction import). The selected entry is tagged
`· global`, so the leak comes entirely from the global plan source.

**Root cause — a seconds-vs-milliseconds unit mismatch.**
`agents.created_at` is stored in **epoch seconds**
(`src/lib/server/db/queries.ts:55` → `Math.floor(Date.now() / 1000)`).
But `listGlobalPlans` in `src/lib/server/plans/agentPlans.ts:200-206`
treats that value as **milliseconds** and compares it to each file's
`mtimeMs`:

```ts
const cutoff = agentCreatedAtMs - GLOBAL_MTIME_SKEW_MS; // seconds (~1.7e9) − 60000
entries.filter((e) => e.modifiedMs >= cutoff)           // mtime ms (~1.7e12) >= ~1.7e9
```

Because a seconds value is ~1000× smaller than a milliseconds value, the
cutoff is effectively zero and **every** global plan in `~/.claude/plans`
passes the filter, no matter how old. The sole production caller
(`src/routes/api/agents/[id]/plan/+server.ts:66-71`) passes
`agent.created_at` (seconds) into the parameter named `agentCreatedAtMs`
— the contract is mislabeled, and the only caller already feeds seconds.

The intended `mtime ≥ spawn − 60s` heuristic never worked. Fixing the
unit makes it work: stale, pre-spawn global plans are excluded, the
agent's own (newest) plan sorts to the top and displays by default, and
when the agent genuinely has no plan the modal shows its clean empty
state instead of three unrelated files.

Per the chosen approach, the local+global **merge stays as-is** — we are
only correcting the time window, not restructuring the sources.

## Change

All edits are in `src/lib/server/plans/agentPlans.ts` (plus its test).
The single production caller already passes seconds, so it needs **no
change** — it becomes correct once the function speaks the same unit as
the rest of the codebase.

1. **Rename the parameter to its true unit and convert internally.**
   - `listAgentPlans(...)`: rename the 4th param `agentCreatedAtMs` →
     `agentCreatedAtSec` and thread it through unchanged.
   - `listGlobalPlans(agentCreatedAtSec)`: compute the cutoff in ms:
     ```ts
     const cutoffMs = agentCreatedAtSec * 1000 - GLOBAL_MTIME_SKEW_MS;
     entries.filter((e) => e.modifiedMs >= cutoffMs)
     ```
   - This aligns the plans module with the DB-wide convention (every
     `created_at` in `db/types.ts` is epoch seconds), removing the
     foot-gun rather than patching one call site.

2. **Update the file header comment** (lines 19-25): state that the
   global filter uses `agent.created_at` (epoch **seconds**) converted to
   ms, `≥ created_at − 60s`.

No frontend change: `PlanViewerModal.svelte` and the `+server.ts`
endpoint already do the right thing once the list is correctly filtered —
`files[0]` (newest by mtime) becomes the agent's real plan, and the
empty state renders when the filtered list is empty.

## Tests

Update `src/lib/server/plans/agentPlans.test.ts` to encode the corrected
**seconds** contract (currently it passes ms — that's how the bug slipped
through):

- Introduce `const AGENT_CREATED_SEC = 10_000;` and derive
  `const AGENT_CREATED_MS = AGENT_CREATED_SEC * 1000;`. Pass
  `AGENT_CREATED_SEC` as the 4th arg to every `listAgentPlans(...)` call;
  keep using `AGENT_CREATED_MS` (and the `± skew` deltas) for the mocked
  `stat` mtimes, since those are real millisecond mtimes. The existing
  boundary/merge assertions then hold under the corrected math.
- **Add a regression test with realistic epoch values** that would have
  caught the original bug: `created_at = 1_749_000_000` (seconds), a
  global plan whose mtime is a few days *before* spawn
  (`(1_749_000_000 - 3*86400) * 1000`) must be **excluded**; one a minute
  *after* spawn must be **included**. Asserting on a seconds-scale
  `created_at` (not a contrived ms value) locks the unit in place.

Representative existing cases that already exercise the path and must
keep passing: `excludes a global plan older than created_at − 60s`,
`skew boundary…`, and `merges local + global, sorted by mtime desc…`.

## Verification

1. `pnpm test src/lib/server/plans/agentPlans.test.ts` — unit suite,
   including the new realistic-epoch regression case.
2. `pnpm lint` and `pnpm test` — full suite stays green.
3. End-to-end against the running app: open "Show Plan" for the
   `feat-archive-crashed-agents` agent and confirm
   (a) the three pre-spawn global plans
   (`first-render-after-startup-rosy-bird.md`,
   `import-of-consorsbank-pdf-frolicking-haven.md`,
   `please-add-import-for-zazzy-hollerith.md`) no longer appear, and
   (b) the agent's own worktree plan is shown by default — or, if it has
   not authored one, the empty state renders instead of unrelated files.
   Spot-check a second agent that *does* have a same-window global plan to
   confirm the merge still surfaces legitimately recent global plans.
