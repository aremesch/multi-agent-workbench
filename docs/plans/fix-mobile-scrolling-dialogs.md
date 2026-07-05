# Fix mobile touch-scrolling in agent & log dialogs

## Context

In the mobile PWA, users **cannot** scroll with touch inside the **agent dialog**
(`AgentWindowModal` → `AgentTerminalPanel`) or the **log dialog**
(`ArchivedAgentLogModal`). The **plan dialog** (`PlanViewerModal`) scrolls fine.

**Root cause.** The plan dialog scrolls a plain DOM element
(`.markdown-body`, `overflow: auto`, default `touch-action`) — native momentum
touch-scrolling just works. The agent and log dialogs both embed an xterm.js
terminal via the shared `Terminal.svelte` wrapper. xterm's scrollable element is
`.xterm-viewport`, but xterm renders its content into a **sibling** `.xterm-screen`
(canvas layers) that sits *on top* of the viewport. A touch therefore lands on
`.xterm-screen`, whose touch events never reach the sibling `.xterm-viewport`, so
the browser's native scroll of the viewport is never triggered. This is a
well-known xterm.js limitation (no built-in touch-drag scrolling). The existing
`touch-action: pan-y` on the host/viewport cannot help, because there is no
ancestor scroll container for the browser to pan — the only scrollable element is
the viewport the touch never reaches.

Because both broken dialogs route through the single `Terminal.svelte` wrapper,
one fix there repairs both.

## Approach

Add a **touch-to-scroll bridge** in `Terminal.svelte` that translates a
single-finger vertical drag anywhere over the terminal into a scroll of
`.xterm-viewport`. This mirrors what xterm's own wheel handler does (it mutates
`viewport.scrollTop`), so xterm stays in sync via its internal `scroll` listener.

### File to modify

`src/lib/client/components/Terminal.svelte`

### Implementation

Inside the `onMount` async IIFE, **after `term.open(container)`** (so the xterm
DOM exists) and alongside the existing `ResizeObserver`/`window resize` wiring:

1. Resolve the viewport: `const viewport = container.querySelector('.xterm-viewport')`.
   Guard on null (defensive — should always exist after `open`).
2. Attach listeners to `container` (the `.terminal-host`, not the viewport) so
   drags starting over `.xterm-screen` are captured:
   - `touchstart` (passive): if `e.touches.length === 1`, record
     `lastY = e.touches[0].clientY`.
   - `touchmove` (`{ passive: false }`): if single touch, compute
     `dy = lastY - currentY`, set `lastY = currentY`, apply
     `viewport.scrollTop += dy`, and `e.preventDefault()` to suppress any
     competing default gesture. Only preventDefault when the viewport is
     actually scrollable (`viewport.scrollHeight > viewport.clientHeight`) so a
     non-scrolling terminal doesn't swallow the gesture.
   - Ignore multi-touch (pinch/zoom) by bailing when `touches.length !== 1`.
3. Register the listeners' removal in the existing `cleanup` closure (which
   already tears down the resize listener/observer and disposes `term`).

Only `touchmove` (a drag) calls `preventDefault`; a plain `touchstart`/tap is
left untouched, so xterm's existing tap-to-focus behaviour (and the deliberate
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
