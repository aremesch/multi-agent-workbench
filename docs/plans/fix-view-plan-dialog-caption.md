# Fix: plan-viewer header overflows on smartphone portrait

## Context

When the plan-viewer dialog is opened from an agent's kebab menu on a phone
in portrait orientation, the file-switcher `<select>` in the header is wide
enough (its CSS cap is `max-width: 22rem` ≈ 352 px) that it consumes the
entire dialog width. The "Markdown" copy button is clipped (the screenshot
shows it ending after "Marko") and the close button (`×`) is pushed off
the right edge of the viewport entirely — making the dialog unclosable
without a back-gesture / Esc.

Cause: in `Modal.svelte` the `.head-right` slot is `flex: 0 0 auto`
(intentional — it must not be squashed by a long title). Inside it,
`PlanViewerModal`'s `.switcher select` is sized to its content up to
22 rem with no shrink behavior, so on a narrow viewport the slot
balloons past the available width.

Intended outcome: on phones the select shrinks to fit; the selected
filename truncates with an ellipsis inside the closed select (the dropdown
list still shows full names on tap); the "Markdown" button and `×` remain
visible on the same row.

## Approach

Scoped CSS change in **`src/lib/client/components/PlanViewerModal.svelte`**
only — no edits to the shared `Modal.svelte` (its `flex: 0 0 auto` on
`.head-right` is correct for the other consumers).

Two pieces:

1. **Make the select shrinkable.** Add `min-width: 0` on `.header-right`
   and `.switcher`, and let the `<select>` shrink with the slot
   (`min-width: 0` on the select, keep existing `max-width: 22rem` as the
   desktop cap). Native `<select>` already ellipsis-truncates the
   currently-selected option when its rendered width is smaller than the
   option's text, so no JS / label trimming is needed.

2. **Tighter cap on narrow viewports.** Add a `@media (max-width: 600px)`
   block (matches the existing breakpoint used by `src/routes/queue/+page.svelte:1041`)
   that overrides `.switcher select { max-width: ... }` with a small value
   (~`10rem`) and removes any min-width. That leaves room on a ~360 px
   dialog for: shrunk select (~160 px) + gap + "Markdown" button (~95 px)
   + gap + close button (~32 px), with the title (`flex: 0 1 auto`,
   already `min-width: 0` in `Modal.svelte:122-138`) absorbing any
   remaining squeeze via ellipsis.

The Modal's existing title-ellipsis behavior (`Modal.svelte:122-138`,
documented in the comment there) means once the header-right slot is
shrinkable, the title degrades gracefully and nothing gets pushed off-screen.

## Critical files

- `src/lib/client/components/PlanViewerModal.svelte` — the only file
  edited. Touch the `<style>` block: `.header-right` (line 364),
  `.switcher select` (line 369), and add a new `@media (max-width: 600px)`
  rule near the bottom of the stylesheet.

## Verification

End-to-end check on a real (or emulated) phone-width viewport:

1. `pnpm dev`, open the dashboard, ensure at least one agent has 2+ plan
   files in its `docs/plans/` (or in `~/.claude/plans`) so the switcher
   renders.
2. In Chrome/Firefox devtools, toggle device emulation to a narrow
   profile (e.g. iPhone SE — 375 × 667). Open the agent's kebab menu →
   "Show Plan".
3. Confirm in the dialog header: the select is visibly narrow (selected
   option text shows ellipsis), the "Markdown" button label is fully
   readable, and the `×` close button is fully inside the dialog and
   tappable. Tapping the select still opens the native list with full
   filenames + timestamps.
4. Resize to ≥ 700 px wide: the select returns to its previous (up to
   22 rem) width — no regression for desktop / tablet landscape.
5. Sanity-check the task-plan variant (Tasks page → 📄 Plan badge) at the
   same narrow width: no switcher rendered (single file), copy button and
   close button still both visible.
6. `pnpm check` to confirm no Svelte / TS warnings introduced by the
   style change.
