# Fix mobile touch-scrolling in agent & log dialogs

## Context

In the mobile PWA, users **cannot** scroll with touch inside the **agent dialog**
(`AgentWindowModal` → `AgentTerminalPanel`) or the **log dialog**
(`ArchivedAgentLogModal`). The **plan dialog** (`PlanViewerModal`) scrolls fine.

**Root cause.** The plan dialog scrolls a plain DOM element
(`.markdown-body`, `overflow: auto`, default `touch-action`) — native momentum
touch-scrolling just works. The agent and log dialogs both embed an xterm.js
terminal via the shared `Terminal.svelte` wrapper, and **xterm.js has no working
touch scrolling**:

- The rendered content lives in a `.xterm-screen` canvas that sits *over* the
  scrollable `.xterm-viewport`, so a touch lands on the canvas and native
  viewport scroll never fires.
- xterm **v6** bundles VS Code's `Gesture` class (which would translate touch
  pans into scrolls) but **never registers a target** (`Gesture.addTarget` is
  never called), so that touch-pan path is dormant.

Because both broken dialogs route through the single `Terminal.svelte` wrapper,
one fix there repairs both.

## Approach

Add a **touch-to-scroll bridge** in `Terminal.svelte` that translates a
single-finger vertical drag anywhere over the terminal host into scrolling via
xterm's **public `term.scrollLines()` API**.

> Note: an earlier attempt mutated `viewport.scrollTop` directly. That does not
> work in xterm v6 — scrolling is routed through a VS Code `ScrollableElement`
> that overrides any `scrollTop` we set — so we drive the public API instead.

### File to modify

`src/lib/client/components/Terminal.svelte`

### Implementation

Inside the `onMount` async IIFE, **after `term.open(container)`** (so the xterm
DOM exists) and alongside the existing `ResizeObserver`/`window resize` wiring:

1. Attach listeners to `container` (the `.terminal-host`) so drags starting over
   `.xterm-screen` are captured:
   - `touchstart` (passive): record `lastY` from the single touch; reset the
     sub-line pixel remainder.
   - `touchmove` (`{ passive: false }`): compute `dy = lastY - currentY`,
     convert accumulated pixels to whole lines using per-row height
     (`viewport.clientHeight / term.rows`), carry the remainder across moves,
     and call `term.scrollLines(lines)`. `preventDefault()` only when there is
     scrollback to move through (`term.buffer.active.baseY > 0`).
   - Ignore multi-touch (pinch/zoom) by bailing when `touches.length !== 1`.
2. Register the listeners' removal in the existing `cleanup` closure.
3. Set `touch-action: none` on `.terminal-host` / `.xterm-viewport` (was
   `pan-y`). Since we own scrolling in JS, suppressing the browser's native
   pan/zoom keeps every `touchmove` cancelable — with `pan-y`, Android can
   fast-track a native pan of the scrollable modal ancestor and deliver
   non-cancelable moves that ignore our `preventDefault`.

Only `touchmove` (a drag) calls `preventDefault`; a plain `touchstart`/tap is
left untouched, so xterm's tap-to-focus behaviour (and the deliberate
soft-keyboard trigger described in the current comments) is preserved.

### CSS note

Keep `touch-action: pan-y` on `.terminal-host` and `.xterm-viewport` — it still
correctly blocks horizontal pans/zoom while permitting the vertical gesture our
handler consumes. No CSS-only fix is possible here (the touch never reaches the
scrollable element), so the JS bridge is required.

## Verification

- `pnpm install` (node_modules is absent in this worktree), then run the app
  (`pnpm dev`) and open it in a mobile browser or Chrome DevTools device
  emulation with **touch emulation on** (pointer: coarse).
- Spawn/open an agent so the **agent dialog** shows a terminal with enough
  scrollback to overflow; confirm single-finger drag scrolls the terminal up and
  down, and that tapping still focuses the terminal / raises the soft keyboard.
- Open an archived agent **log dialog**; confirm the same touch-scroll works.
- Regression-check the **plan dialog** still scrolls (untouched) and desktop
  mouse-wheel scrolling of terminals still works.
- Confirm horizontal swipes and pinch-zoom are not hijacked (multi-touch ignored,
  `pan-y` retained).
