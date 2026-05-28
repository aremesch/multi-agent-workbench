# Fix agent state inconsistency across views

## Context

The same agent can appear with different state labels in three places at
once. The user's concrete example:

| View | File | Shown | Source |
| --- | --- | --- | --- |
| Task dashboard (`/queue`) | `src/routes/queue/+page.svelte` | `LÄUFT` ("running") | `QueueEntryStatus` (i18n-translated) |
| Repo dashboard | `src/routes/repos/[id]/+page.svelte` → `AgentWindowModal` | `WAITING_INPUT` | `AgentStatus` (raw enum) |
| Agent dialog | `src/lib/client/components/AgentWindowModal.svelte` | `WAITING_INPUT` | `AgentStatus` (raw enum) |

Root causes:

1. **Two enums, one entity.** `QueueEntryStatus` (queries.ts /
   `db/types.ts`) tracks the *queue lifecycle stage* (`pending →
   ready/blocked → running → done/failed/cancelled`) while `AgentStatus`
   (`shared/types.ts`) tracks the *agent's runtime state* (`spawning,
   running, waiting_input, idle, exited, crashed`). The user treats them
   as a single entity ("essentially the same in different stages"). The
   queue page shows lifecycle stage; agent views show runtime state.
2. **No client-side single source of truth.** Each consumer holds its own
   copy of `agent.status` as local component state (`AgentCard` reads
   from props only, `AgentTerminalPanel` keeps a `$state` fed by WS,
   `AgentWindowModal` keeps its own `openAgentStatus`, each `+page.svelte`
   keeps a third copy). Updates only reach the component currently
   subscribed to that agent's WS feed (`subscribe_agent`). The queue
   page and the sidebar never receive WS state updates at all.
3. **No process-wide state fan-out.** The hub broadcasts `agent_state`
   only to `subscribe_agent` subscribers. There is an analogous
   `subscribe_user_alerts` channel + `AlertBus` for per-user alert
   fan-out, but no equivalent for state.
4. **Badge label duplication.** Status pills are styled in four
   different `<style>` blocks (`AgentCard`, `AgentWindowModal`,
   `routes/+page.svelte`, `RepoTreeSidebar`) and the raw enum value is
   rendered as text — no i18n. Queue uses i18n via `queue.status.<key>`.

Goal: one reactive store, one strict badge component, one set of i18n
keys, one process-wide fan-out — so every place that displays an
agent/task's state shows the same value at the same time.

## Approach

### 1. Server: per-user agent-state fan-out

Mirror the alert-bus pattern.

- **New `src/lib/server/agents/AgentStateBus.ts`** — singleton EventEmitter
  on `globalThis` (same shape as `AlertBus.ts`). API:
  `emitUserAgentState(userId, agentId, status)` and
  `onUserAgentState(handler)`.
- **`AgentSupervisor.wireAlertBus`** (renames to `wireBuses`, or add
  `wireStateBus` alongside) — every new/reattached runtime gets a
  `runtime.on('state', …)` listener that calls
  `AgentStateBus.emitUserAgentState(userId, agentId, status)`. Also fire
  once in `finishAsExited` so the terminal `exited`/`crashed` transition
  always reaches the bus regardless of whether the runtime emitted before
  it was removed from the map (line 449 of AgentSupervisor.ts).
- **`src/lib/server/ws/hub.ts`** — add `subscribe_user_agents` /
  `unsubscribe_user_agents` cases (mirroring the existing
  `subscribe_user_alerts` handlers at lines 153/156). The subscription
  registers an `AgentStateBus` listener filtered by `this.userId` and
  forwards as the existing `agent_state` server message
  (`{type:'agent_state', agentId, status}`). Cleanup in the existing
  `cleanup()` path.
- **`src/lib/shared/protocol.ts`** — extend the `ClientMessage` union with
  two new types: `subscribe_user_agents` and `unsubscribe_user_agents`.
  Existing `SC_AgentState` server message is reused as-is.

### 2. Client: shared state store

- **New `src/lib/client/stores/agentStatus.svelte.ts`** — Svelte 5
  rune-backed module. Pattern mirrors `i18n.svelte.ts`:
  - Module-private `let statuses = $state<Map<string, AgentStatus>>(new Map())`.
  - Lazy WS bootstrap on first `useAgentStatus()` call: subscribes once
    via a new `MawWsClient.subscribeUserAgents(cb)` and writes incoming
    `(agentId, status)` into the map. Survives reconnect via the same
    `wantUserAgents` flag pattern used for `wantUserAlerts`.
  - `seed(rows: { id, status }[])` — bulk seed from server-loaded
    `AgentCardRow[]`; only writes if the entry is missing (WS is
    authoritative once it has a value, so a stale page-data refresh
    can't clobber a newer live status).
  - `get(agentId): AgentStatus | undefined`.
- **`src/lib/client/ws.ts`** — add `subscribeUserAgents(cb)` /
  `unsubscribeUserAgents()` mirroring the existing `subscribeUserAlerts`
  pair (lines 260–273), plus the `wantUserAgents` reconnect flag in
  `onopen` (lines 99–101). Reuse the existing `globalStateListeners`
  Set or add a sibling set — the per-agent listener dispatch already
  routes `agent_state` to both (lines 320–323).

### 3. Strict UI component

- **New `src/lib/client/components/AgentStatusBadge.svelte`** — strict
  props `{ status: AgentStatus | null }`. Renders one `<span>` with the
  `status-<status>` class and the translated label from new i18n keys
  `agent.status.<status>` (Spawning / Running / Waiting input / Idle /
  Exited / Crashed). Owns the badge CSS (lifted verbatim from the four
  existing copies — they're already consistent in colors). When `status`
  is null/empty, renders nothing.
- **New i18n keys** added to all four locale files (`en.ts`, `de.ts`,
  `fr.ts`, `es.ts`). German labels: Spawning → "Startet", Running →
  "Läuft", Waiting input → "Wartet auf Eingabe", Idle → "Inaktiv",
  Exited → "Beendet", Crashed → "Abgestürzt". Aligns with the existing
  `queue.status.*` translations.

### 4. Refactor consumers

Pattern for every consumer that currently reads agent status:

```svelte
<script lang="ts">
  import { useAgentStatus } from '$lib/client/stores/agentStatus.svelte';
  import AgentStatusBadge from '$lib/client/components/AgentStatusBadge.svelte';
  const store = useAgentStatus();
  // Seed once from server-loaded rows
  $effect(() => { store.seed(data.liveAgents); });
  // Derived current status — falls back to the seeded value if WS hasn't
  // delivered an update yet.
  const status = $derived(store.get(agent.id) ?? agent.status);
</script>
<AgentStatusBadge {status} />
```

Files to update — delete the per-component status `$state`, the
`onStatusChange` plumbing in the modal/panel, and the duplicated CSS
blocks; render `<AgentStatusBadge>` instead:

- `src/lib/client/components/AgentCard.svelte` — gains live status (was
  static from props only).
- `src/lib/client/components/AgentWindowModal.svelte` — drop
  `openAgentStatus` state + the `$effect` that seeds it; pass
  `store.get(agent.id) ?? agent.status` into `AgentMenu` and the badge.
- `src/lib/client/components/AgentTerminalPanel.svelte` — drop the
  `status` `$state` and the `onStatusChange` callback prop entirely
  (callers no longer need it; the modal reads the store directly). The
  per-agent `subscribe_agent` subscription still handles its real job
  (output bytes); the global `subscribe_user_agents` path now owns
  status delivery.
- `src/routes/+page.svelte` — drop `openAgentStatus` + its `$effect`;
  drop the local status pill snippet (`AgentWindowModal` already owns
  the badge slot via `headerRight`).
- `src/routes/repos/[id]/+page.svelte` — only seeds the store; no other
  changes.
- `src/lib/client/components/RepoTreeSidebar.svelte` — sidebar dot's
  class becomes `class="dot status-{store.get(agent.id) ?? agent.status}"`
  using the same store, so it goes live too.
- `src/routes/queue/+page.svelte` — for each entry with `agent_id` whose
  agent is present in the store (i.e. live), the displayed badge becomes
  `<AgentStatusBadge status={store.get(e.agent_id)} />`. Falls back to
  the existing `statusLabel(e.status)` pill (queue lifecycle) when no
  agent is linked or the agent has terminal status. Grouping logic
  (`groupEntries`) keeps using `QueueEntryStatus` — it controls section
  membership, not the badge label. Seed the store from
  `data.agentsById` on mount.

### 5. Where to seed

`+layout.server.ts` already returns every user agent via
`sidebar.activeRepos[*].agents` and `sidebar.archivedRepos[*].agents`
(`listAgentCardsForUser` with `ALL_STATUSES`). In `+layout.svelte`,
flatten and call `store.seed(...)` inside an `$effect` so every page
inherits the seed even if its own load doesn't return agents (queue,
account, settings). Individual pages still re-seed from their richer
`data.liveAgents` / `data.agentsById` to cover edge cases where the
sidebar hasn't been rebuilt yet.

## Critical files

- `src/lib/server/agents/AgentStateBus.ts` (new) — pattern from `AlertBus.ts`
- `src/lib/server/agents/AgentSupervisor.ts` (lines 376–382, 449)
- `src/lib/server/ws/hub.ts` (lines 97–164, 216–218, cleanup path)
- `src/lib/shared/protocol.ts` — add two `ClientMessage` variants
- `src/lib/client/ws.ts` (lines 73–77, 87–103, 260–273, 320–323)
- `src/lib/client/stores/agentStatus.svelte.ts` (new)
- `src/lib/client/components/AgentStatusBadge.svelte` (new)
- `src/lib/i18n/{en,de,fr,es}.ts` — add `agent.status.*` keys
- `src/routes/+layout.svelte` — global seed
- Consumer refactors (see §4 list)

## Verification

1. **Unit tests**
   - `AgentStateBus.test.ts` — emit/listen, unsubscribe.
   - `agentStatus.svelte.test.ts` — seed/get/update precedence (WS
     beats stale seed).
   - `AgentStatusBadge.test.ts` — renders correct class + i18n label
     for every `AgentStatus`; nothing when null.
2. **Hub WS test** — extend `hub.test.ts` with a
   `subscribe_user_agents` case: a state event on AgentRuntime A
   reaches a client that subscribed to user agents but never
   `subscribe_agent`'d A.
3. **Existing tests** must still pass:
   `pnpm test` (vitest), `pnpm check` (svelte-check), `pnpm lint`.
4. **End-to-end manual check** (the user's exact scenario):
   - Spawn an agent that prompts for permission (e.g. claude-code task
     that triggers a tool-permission dialog).
   - Open all three views in separate tabs: `/`, `/repos/<id>`,
     `/queue`.
   - Confirm all three pills read identically as the agent transitions
     `running → waiting_input → idle → running`.
   - Confirm closing the prompt flips all three to `running`
     simultaneously without reloads.
   - Confirm killing the agent (`/exit` inside claude-code) flips all
     three to `exited` and the sidebar dot recolors.
5. **Playwright** — extend an existing dashboard test (under
   `tests/`) with the WS state assertion if one already covers the
   modal, otherwise add a focused spec.
