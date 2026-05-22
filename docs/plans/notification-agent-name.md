# Agent title in notifications

## Context

When the user receives a push notification or in-app toast that an agent needs
input (or has exited / completed / errored), the most important question is
*"which agent?"* — but today the title shows the bare CLI kind:

- `"claude-code: Permission needed — Agent needs your input"`
- `"claude-code: Agent exited — Agent in multi-agent-workbench has stopped."`

The spawn flow always sets a task title (`tasks.title` is `NOT NULL`,
validated in `spawnFromInputs.ts:179`) — that's the human-meaningful name the
user picked when launching the agent and what they'd recognize on a lock
screen. We already resolve it via `agentDisplayName()` in
`AgentRuntime.ts:413`, and the OS-push path partially uses it for
`prompt_detected`/`task_done`/`error` — but as a prefix joined with
`" · "`, so on a phone the agent name shares the title line with the reason
and gets truncated. The agent-exit path
(`AgentSupervisor.ts:485-489`) hardcodes `cli_kind` and ignores the task
title entirely. The in-app toast (`AlertToast.svelte:43`) only renders
`reason`, so for the exit path it shows just `"Agent exited"` — no agent
identification at all.

Goal: make the agent title the *primary* title across every alert surface
(OS push + in-app toast), and move the reason/detail to the body.

## Approach

Treat the agent title as a first-class field on the alert payload — not a
string prefix munged into `reason`. Restructure the notification so the
**title slot is the agent title and the body slot carries the reason +
detail**:

| Surface     | Title (prominent) | Body (subtitle / 2nd line)          |
|-------------|-------------------|--------------------------------------|
| OS push     | `Implement notifications` | `Permission needed: Bash — rm -rf /tmp/foo` |
| In-app toast| `Implement notifications` | `Permission needed: Bash` + detail line |

The existing `alertReason()` already builds the right "what" half — we just
need to stop prefixing the agent name into it, carry the agent title as a
separate field through the alert pipeline, and use it as the OS-push title
and the toast's prominent line. The `agentTitle` field is already partially
plumbed in the push payload (`data.agentTitle` at `AgentRuntime.ts:394`) — we
extend the same field across the WS protocol and toast store, and use it
where it matters.

## Changes

### Server

**`src/lib/server/agents/AgentRuntime.ts`** — restructure `alertReason()` /
`maybeAlert()`:

- `alertReason(agent, ev)` returns just the "what": `"Permission needed: Bash"`,
  `"Task complete"`, `"Error: rate_limit"`. Drop the `${who} · ` prefix.
- `maybeAlert()` computes `const agentTitle = agentDisplayName(this.agent)`
  once, and:
  - Push payload: `title: agentTitle`, `body: body ? `${reason} — ${body}` :
    reason`. The existing `data.agentTitle` stays for compatibility.
  - `runtime.emit('alert', …)` includes a new `agentTitle` field alongside
    the existing `reason`/`body`.
- `alertBody()` is unchanged — it already extracts the detail
  (`cmd`/`file_path`/`args`/etc.).
- DB column `alerts.reason` stores the semantic reason (e.g.
  `"Permission needed: Bash"`), not the pre-joined title. Existing rows are
  not migrated — they're historical.

**`src/lib/server/agents/AgentSupervisor.ts`** (`finishAsExited`,
lines 468-490) — use `agentDisplayName(agent)` and the same title/body
split:

- Push title: `agentDisplayName(agent)` (e.g. `"Implement notifications"`)
- Push body: `"Agent exited — in ${repoName}"` (folds repo into one line)
- `alerts.reason` stays `"Agent exited"`; `payload_json` gains a `body`
  field so toast rendering matches the prompt path.
- `runtime.emit('alert', …)` includes `agentTitle` and `body`.

### Protocol & client

**Wherever `AlertPayload` / `SC_Alert` is defined** (likely
`src/lib/shared/messages.ts` or `schemas/*.ts` — locate via the existing
`SC_Alert` type; same mapper used at `hub.ts:524-533`):

- Add optional `agentTitle?: string` to the alert message shape.
- The hub mapping (AlertPayload → SC_Alert) passes `agentTitle` through.

**`src/lib/client/stores/alertToasts.ts`** (the `ToastEntry` mapper near
lines 50-58 per the exploration) — propagate `agentTitle` into `ToastEntry`.

**`src/lib/client/components/AlertToast.svelte`** — split the render into
two lines:

- Top line (was `entry.reason`, bold): now `entry.agentTitle ?? entry.reason`
  (fallback covers older WS messages mid-deploy, then can be dropped).
- Subtitle line (new): `entry.reason` when `agentTitle` is present.
- Existing `entry.body` line stays as the third (detail) line.

### Tests

Existing unit tests live next to the relevant code (the v0.2 plans cite
unit-test patterns). Update:

- `alertReason()` tests — assert it no longer includes the `${who} · `
  prefix; assert the new outputs for `prompt_detected`/`task_done`/`error`.
- Add tests for `maybeAlert` confirming the OS-push `title` equals
  `agentDisplayName(agent)` and `body` equals `${reason} — ${alertBody}` (or
  bare `reason` when body is empty).
- Add a test for `AgentSupervisor.finishAsExited` exit-alert payload:
  `title === agentDisplayName(agent)`, `reason === 'Agent exited'`, body
  contains repo name.

## Verification

- `pnpm test` — unit tests pass, including updated `alertReason`/exit-path
  cases.
- Run the dev server (`pnpm dev`), spawn a claude-code agent with a
  recognizable task title, and:
  1. Trigger a Bash permission prompt — confirm the OS push shows the task
     title as the title and `"Permission needed: Bash — <cmd>"` as the body,
     and the in-app toast shows the same two-line structure with the agent
     title prominent.
  2. Let the task complete — confirm `task_done` notification shows task
     title + `"Task complete"`.
  3. Kill the agent (or let it exit) — confirm the exit notification shows
     the task title, not `"claude-code: Agent exited"`.
- Confirm `data.agentTitle` already in the push payload still resolves
  correctly (sanity check via DevTools → Application → Service Workers →
  push event log).
- Manual smoke on phone PWA (the primary surface) — verify the task title
  is the bold first line on the lock screen.
