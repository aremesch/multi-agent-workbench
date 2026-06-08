# Add ENTER and TAB mobile quick-key buttons to the agent terminal

## Context

On a phone (the PWA's primary use case), the soft keyboard often hides or
makes awkward the keys an agent CLI needs constantly. MAW already solves this
with **mobile quick-keys**: a row of virtual buttons rendered under xterm in
the agent dialog (`AgentTerminalPanel.svelte`) that send raw key bytes to the
agent's tmux pane via the existing `send_keys` WebSocket path. The buttons are
declared per-adapter in `cli-adapters/*.jsonc`; the component renders whatever
the active agent's adapter declares and is gated by touch detection
(`pointer: coarse`) plus the `ui.mobileQuickKeys` setting (`auto`/`always`).

The user wants **ENTER** and **TAB** added to this row. Current gaps:

- **ENTER** (`\r`) — missing from **every** adapter.
- **TAB** (`\t`) — present in codex, gemini, shell; **missing from claude-code**
  (which only has `↑ ↓ ⇧⇥ Esc`).

Decisions (confirmed with user): apply to **all terminal adapters** for a
consistent row app-wide; reuse the **existing touch quick-keys mechanism** (no
new installed-PWA gating). The two browser adapters are excluded — they have no
tmux pane to receive keystrokes (their `mobileQuickKeys` are intentionally `[]`).

No component, WebSocket, schema, or server changes are needed — this is purely
adapter config + a test update. The rendering, `pressQuickKey` →
`getMawWsClient().sendKeys(agent.id, keys)` path, and schema validation already
support arbitrary quick keys.

## Changes

### 1. Adapter config files (`cli-adapters/*.jsonc`)

New entries (matching the existing symbol-label style and JSON escape style):

- ENTER: `{ "id": "enter", "label": "⏎", "keys": "\r" }`
- TAB:   `{ "id": "tab",   "label": "⇥", "keys": "\t" }`

Per-adapter edits to the `mobileQuickKeys` array:

- **`cli-adapters/claude-code.jsonc`** — add **both** `tab` and `enter`.
  Resulting order: `up, down, tab, shift-tab, esc, enter`.
  (Place `tab` next to `shift-tab` for logical grouping; `enter` last.)
  Update the explanatory comment above the array (lines 15–18) to mention
  Enter/Tab alongside the existing arrow/Esc/Shift+Tab rationale.

- **`cli-adapters/codex.jsonc`** — add `enter` only (tab already present).
  Resulting order: `up, down, tab, esc, ctrl-c, enter`.

- **`cli-adapters/gemini.jsonc`** — add `enter` only.
  Resulting order: `up, down, tab, esc, ctrl-c, enter`.

- **`cli-adapters/shell.jsonc`** — add `enter` only.
  Resulting order: `up, down, tab, esc, ctrl-c, enter`.

- **`cli-adapters/browser.jsonc`**, **`cli-adapters/browser-stream.jsonc`** —
  **no change** (empty by design; no tmux pane).

Rationale for the `keys` values: xterm's `onData` emits `\r` for Enter and
`\t` for Tab, so these bytes are exactly what a real keypress sends through
the same channel — they round-trip through `sendKeys` (base64) →
`enqueueRawKeys` → `tmux send-keys -l` unchanged.

### 2. Test update (`src/lib/server/agents/adapters/claude-code-lifecycle.test.ts`)

In the existing `describe('mobileQuickKeys carry exact VT220 escape sequences')`
block, add two cases mirroring the existing ones:

```ts
it('tab = \\t', () => {
  const a = loadClaudeCodeAdapter();
  const tab = a.mobileQuickKeys.find((k) => k.id === 'tab');
  expect(tab?.keys).toBe('\t');
});

it('enter = \\r', () => {
  const a = loadClaudeCodeAdapter();
  const enter = a.mobileQuickKeys.find((k) => k.id === 'enter');
  expect(enter?.keys).toBe('\r');
});
```

This pins the new claude-code keys (the file most likely to regress, and the
only adapter with a dedicated lifecycle suite). Structural validity for the new
entries on all adapters (lowercase-kebab id, non-empty label/keys, unique ids)
is already enforced by `adapter.config.schema.test.ts` and `AdapterRegistry`
loading at startup, so no extra per-adapter tests are required.

## Files

- `cli-adapters/claude-code.jsonc` (add tab + enter, update comment)
- `cli-adapters/codex.jsonc` (add enter)
- `cli-adapters/gemini.jsonc` (add enter)
- `cli-adapters/shell.jsonc` (add enter)
- `src/lib/server/agents/adapters/claude-code-lifecycle.test.ts` (2 new cases)

## Verification

1. **Unit tests** — `pnpm test` (or target the adapter suites). The new
   claude-code cases pass; existing quick-key, schema, and registry tests stay
   green (no duplicate-id failures, all JSONC parses).
2. **Lint** — `pnpm lint`.
3. **Manual / PWA** — run the app (`pnpm dev`), open an agent dialog. On a touch
   device the quick-key row shows the new `⏎` and `⇥` buttons; on desktop set
   `ui.mobileQuickKeys` to `always` to reveal them. Tapping `⏎` submits a line
   to the agent (e.g. confirms a prompt); tapping `⇥` triggers tab completion /
   menu cycling. Confirm focus stays in xterm (buttons use
   `onmousedown preventDefault`).

## Housekeeping

Per repo plan conventions, immediately after approval rename this plan to match
the branch name:
`git mv docs/plans/please-add-the-following-humming-bunny.md docs/plans/feat-additional-pwa-buttons.md`
On completion, `git mv` it into `docs/plans/done/`.
