# Mobile copy & paste gestures for the terminal (agent + log dialogs)

## Context

On the PWA (phone), the live **agent dialog** and the read-only **log dialog**
both render their output through xterm.js on a `<canvas>`. xterm's built-in
text selection is **mouse-only** — there is no touch equivalent — so on a phone
a user cannot select or copy any terminal text. Recent work added a
touch-to-scroll bridge (`docs/plans/fix-mobile-scrolling-dialogs.md`), but
selection was never addressed.

Goal: let a phone user **long-press to select the word under their finger**,
then **drag two handles (at the start and end of the selection)** to grow or
shrink it, exactly like native mobile text selection (see the reference
screenshot in the task). A floating toolbar then offers **Copy** (both
dialogs) and **Paste** (live agent terminal only — it feeds text back into the
running CLI). This makes copy/paste work phone-first, matching MAW's driving
goal #1.

Both dialogs share **one** renderer — `Terminal.svelte` — so, like the scroll
fix, a single change covers both.

## Key facts established during exploration

- **Single shared component:** `src/lib/client/components/Terminal.svelte`
  wraps xterm and is embedded by both `AgentTerminalPanel.svelte:396`
  (live, passes `onData` + `onResize`) and `ArchivedAgentLogModal.svelte:118`
  (read-only, passes only `onResize`). → Paste can be gated purely on
  `onData != null`; no new prop needed.
- **xterm selection API is sufficient** (verified against the installed
  `@xterm/xterm@6.0.0` source, not docs):
  - `term.select(col, row, length)` — **0-based column**, **absolute buffer
    row** (0 = top of scrollback), and **`length` wraps across rows** (xterm's
    `finalSelectionEnd` divides the linear length by `cols`). So any multi-row
    selection is just `select(startCol, startRow, totalCells)` where
    `totalCells = (endRow-startRow)*cols + (endCol-startCol)`.
  - `term.getSelection()` → the selected text; `term.getSelectionPosition()` →
    `{start:{x,y}, end:{x,y}}` in **1-based absolute buffer coords** (used to
    position the handles); `term.clearSelection()`, `term.hasSelection()`,
    `term.onSelectionChange(...)`.
  - `term.buffer.active.viewportY` = absolute buffer row at the top of the
    viewport → maps absolute rows ↔ on-screen rows.
  - `term.buffer.active.getLine(absRow)?.translateToString(false, a, b)` →
    row text, for word-boundary detection.
- **The existing touch handlers must be extended, not bypassed.**
  `Terminal.svelte:193-230` installs the scroll bridge; `.terminal-host` and
  `.xterm-viewport` are `touch-action: none` (`:265`, `:274`). A long-press
  must be distinguished from a scroll drag within these same listeners.
- **i18n:** flat-key dictionaries in `src/lib/i18n/{en,de,es,fr}.ts` +
  `index.ts`; `useT()` from `src/lib/client/i18n.svelte.ts` (existing keys use
  the `agentTerminal.*` prefix). New user-facing labels must be added to all
  locales (the user works in German — `de.ts` matters).

## Design

Keep all gesture/DOM logic in `Terminal.svelte`; extract the **pure math &
word logic** into a small testable helper so it can be unit-tested and stays
DRY.

### New file: `src/lib/client/components/terminalTouchSelection.ts`

Pure functions, no DOM/xterm imports (take primitives):

- `pixelToCell(clientX, clientY, screenRect, cols, rows, viewportY)` →
  `{ col, absRow }` (clamped to grid). Uses `cellW = screenRect.width/cols`,
  `cellH = screenRect.height/rows`.
- `cellToPixel(col, absRow, screenRect, cols, rows, viewportY)` →
  `{ x, y, onScreen }` (inverse; `onScreen=false` when the row is scrolled out
  of view so the handle can be hidden).
- `wordRangeAt(lineText, col, separators)` → `{ startCol, endCol }` — expand to
  the whitespace/separator-delimited word under `col` (mirrors xterm's default
  `wordSeparator` set; falls back to a single cell on separators).
- `linearLength(startCol, startRow, endCol, endRow, cols)` → total cell count
  for `term.select`.
- `normalizeEndpoints(a, b)` → ordered `{ start, end }` so dragging one handle
  past the other swaps roles.

Unit-tested with Vitest (`terminalTouchSelection.test.ts`).

### Changes in `Terminal.svelte`

1. **Host becomes a positioning context + overlay:** set
   `.terminal-host { position: relative }` and render, above the canvas, an
   overlay layer holding: two handle elements and one toolbar. Overlay is
   `pointer-events: none` except the handles/toolbar themselves.

2. **Gesture state machine** (Svelte 5 `$state`): `mode: 'idle' | 'selecting'`,
   plus current `{ startCol, startRow, endCol, endRow }`. Reuse the existing
   `container` touch listeners:
   - `touchstart` (single finger): record start point + `performance`-free
     timer via `setTimeout(~450ms)` for long-press. (Existing scroll vars stay.)
   - `touchmove`: if the long-press timer is still pending and movement
     `< ~10px`, **suppress scrolling** (swallow move) and keep waiting; if
     movement exceeds the threshold, **cancel the timer** and fall through to
     the existing scroll logic unchanged.
   - long-press fires → compute cell via `pixelToCell`, read the line via
     `getLine().translateToString()`, `wordRangeAt(...)`, call `term.select(...)`,
     set `mode='selecting'`, `navigator.vibrate?.(15)`, and `preventDefault`
     the rest of this touch sequence so xterm doesn't focus the textarea /
     surface the soft keyboard.
   - In `selecting` mode, a `touchstart` on the terminal body **outside** a
     handle clears the selection and returns to `idle`.

3. **Handles** (two teardrop DOM elements, blue like the screenshot; ~40–44px
   hit area, smaller visual). Positioned each render from
   `getSelectionPosition()` → `cellToPixel(...)`; hidden when their row is
   off-screen. Each handle owns `touchstart/move/end`:
   - on move, `pixelToCell` the finger → update that endpoint →
     `normalizeEndpoints` → recompute `linearLength` → `term.select(...)`.
   - **edge auto-scroll:** when a handle drag is within ~1 row of the top/bottom
     of the viewport, `term.scrollLines(±1)` on an interval so the user can
     extend selection into scrollback, then reposition handles.

4. **Floating toolbar** (`Copy`, and `Paste` only when `onData != null`).
   Positioned above the selection start (flips below if clipped at top).
   - **Copy:** `navigator.clipboard.writeText(term.getSelection())`; show a
     brief `Copied` state (~1.2s); selection + handles stay so the user can
     re-adjust. Fallback to a hidden-`textarea` + `document.execCommand('copy')`
     if `navigator.clipboard` is unavailable (older PWA webviews).
   - **Paste:** `navigator.clipboard.readText()` → `onData(text)` (same path
     as typing; xterm/tmux receive it). Then clear selection.

5. **Cleanup:** clear the long-press timer and any auto-scroll interval, and
   remove handle/toolbar listeners in the existing `cleanup` closure
   (`Terminal.svelte:232`). Subscribe to `term.onSelectionChange` to drop to
   `idle` if streaming output wipes the selection (dispose the subscription in
   cleanup).

6. **i18n:** add `terminalSelect.copy`, `terminalSelect.paste`,
   `terminalSelect.copied` to `en/de/es/fr.ts` (+ `index.ts` typing) and use
   `useT()` in `Terminal.svelte`.

### Coexistence / correctness notes

- The scroll bridge is untouched for real scroll drags — long-press only
  intercepts a **stationary** touch, and a moved finger falls straight through
  to `term.scrollLines`.
- Selection uses **absolute buffer rows**, so scrolling (via edge auto-scroll
  or a later scroll) keeps the selection anchored to the right text; handles
  simply hide when their anchor scrolls out of view.
- No new dependency. Uses only xterm's public API + `navigator.clipboard` /
  `navigator.vibrate` (both already assumed by the PWA; clipboard has an
  `execCommand` fallback).

## Files to change

- **New:** `src/lib/client/components/terminalTouchSelection.ts` (pure helpers)
- **New:** `src/lib/client/components/terminalTouchSelection.test.ts` (Vitest)
- **Edit:** `src/lib/client/components/Terminal.svelte` (gestures, overlay,
  handles, toolbar, i18n) — the only component that changes; both dialogs
  inherit it.
- **Edit:** `src/lib/i18n/{en,de,es,fr}.ts` and `src/lib/i18n/index.ts`
  (3 new keys).

No backend, WebSocket, or `ui/` (shadcn) changes.

## Verification

1. **Unit:** `pnpm test` — cover `terminalTouchSelection.ts`
   (pixel↔cell round-trip, word boundaries incl. separators/line ends,
   linear length across a row wrap, endpoint normalization/swap).
2. **Manual on a real phone / DevTools touch emulation** (both dialogs):
   - Open the agent dialog → long-press a word → it highlights + two handles +
     toolbar appear; haptic tick fires.
   - Drag start/end handles to grow across multiple lines and into scrollback
     (edge auto-scroll); verify the highlighted text matches
     `window.__maw_xterm.getSelection()` (dev-only global at
     `Terminal.svelte:100`).
   - Tap **Copy** → `Copied` shows; paste the clipboard elsewhere to confirm.
   - In the live agent terminal, tap **Paste** → clipboard text lands at the
     CLI prompt. Confirm **Paste is absent** in the log dialog.
   - Tap empty terminal area → selection clears.
   - **Regression:** a normal single-finger drag still scrolls (no accidental
     selection); a plain tap on the live terminal still focuses/opens the
     keyboard; desktop mouse selection is unchanged.
3. **Lint/build:** `pnpm check` (svelte-check) and `pnpm lint`.
