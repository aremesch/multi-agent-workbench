# task-list-responsive

Make the Tasks page (`/queue`) usable on a phone using Material Design 3, and
let a task be expanded inline to read its content + full metadata.

Branch / worktree: `task-list-responsive` (already created).

## Goals

1. **Responsive, M3-correct task list.** The list must be comfortable on a
   compact (phone) window: no horizontal cramping, touch targets ≥ 48dp,
   M3 surface/shape/motion tokens instead of hardcoded hex (so it also
   becomes theme-aware, which it currently is not).
2. **Expand a task inline.** Tapping anywhere on a task row toggles an
   expanded panel showing the full task body **and** the metadata that is
   currently squeezed onto one truncated line (role, repo, model, branch,
   priority, schedule, dependencies, last error). Action buttons/links stay
   independently tappable.

Out of scope: backend/API/schema changes (the `body` field is already in
`data.entries`), the plan-viewer modal (the `📄 Plan` badge keeps its
current modal behavior), the spawn form.

## Current state (why this needs restructuring)

`src/routes/queue/+page.svelte` renders **five** sections (running, ready,
blocked, backlog, completed). Each section duplicates the same
`<li class="entry">` markup with only the status badge, a couple of meta
fields, and the action buttons differing. Styling is hardcoded hex
(`#0b0f17`, `#1f2937`, `#e5e7eb`, …) and does not respond to the M3 theme
tokens in `src/app.css`. `.entry` is a `flex; justify-content: space-between`
row, so on a narrow screen the multi-button action cluster collides with the
title/meta.

Adding an expand panel to five duplicated blocks would mean 5× duplication,
so the entry markup is extracted into one Svelte snippet first. This is a
DRY refactor in direct service of the feature (it touches only this file)
— calling it out explicitly per the "ask before refactor" rule.

## Plan

### 1. Extract a single entry snippet (DRY)

In `+page.svelte`, replace the five `{#each}` blocks with one reusable
`{#snippet taskRow(e, actions)}` where `actions` is a per-section snippet
passed in (each section already needs different buttons). The existing
`planBadge` snippet stays and is rendered inside `taskRow`.

Each section becomes:

```svelte
{#snippet runningActions(e)} …buttons… {/snippet}
<ul class="entries"> {#each grouped.running as e (e.id)} {@render taskRow(e, runningActions)} {/each} </ul>
```

### 2. Expand state + interaction

- `let expanded = $state<Record<string, boolean>>({});`
- `function toggle(id)` flips `expanded[id]` (reassign object for
  reactivity). Multiple rows may be open at once (M3 expandable list, not a
  single-open accordion).
- The collapsed header region (status + title + plan badge + a trailing
  chevron affordance) is the toggle target: `role="button"`,
  `tabindex="0"`, `aria-expanded`, `onclick`, and `onkeydown`
  (Enter/Space) — mirroring the existing keyboard pattern in
  `AgentCard.svelte`.
- Action buttons/links are **siblings** of the toggle region, not nested
  inside it, so they keep their own click handlers with no event-bubbling
  conflict.
- Chevron rotates 180° on expand via
  `--md-sys-motion-duration-short` / `--md-sys-motion-easing-standard`.

### 3. Expanded detail panel — body + full metadata

Rendered only when `expanded[e.id]`:

- **Task content**: `e.body` in a `white-space: pre-wrap; word-break:
  break-word` block, capped height with internal scroll for long bodies.
  Empty-state line when `e.body` is null/blank.
- **Metadata** as a responsive `<dl>` (label/value pairs): role, repo,
  model, source branch, priority, scheduled-for, depends-on (mapped to
  titles via the existing `depTitle`), created/updated, and `last_error`
  if present. Reuses existing `queue.column.*` i18n keys; the truncated
  one-line `.entry-meta` is removed from the collapsed view (its data now
  lives, untruncated, in the panel) — the collapsed row keeps only the
  status badge, title, and plan badge so it stays scannable on a phone.

### 4. Material Design 3 styling pass (this file's `<style>` only)

Swap hardcoded hex for the tokens already defined in `src/app.css`:

- Surfaces: row = `--md-sys-color-surface-container-low`; hover/expanded
  = `--md-sys-color-surface-container` / `-high`; panel =
  `--md-sys-color-surface-container-lowest`.
- Text: `--md-sys-color-on-surface` (title), `--md-sys-color-on-surface-
  variant` (meta/labels).
- Borders: `--md-sys-color-outline-variant`.
- Shape: `--md-sys-shape-corner-md` (rows), `-sm` (badges/panel),
  `-full` (status pills).
- Status badges become theme-aware via the semantic tokens
  (`--md-sys-color-success/info/error/warning`) + `color-mix` for the
  tinted background, instead of fixed hex. Mapping: running/done →
  success, ready → info, blocked/pending → outline/surface-variant,
  backlog → secondary-container, failed → error, cancelled →
  surface-variant.
- Links/buttons keyed off `--md-sys-color-primary`; danger off
  `--md-sys-color-error`.
- FAB already uses tokens — only add `env(safe-area-inset-bottom)` to its
  offset and add page bottom padding so the FAB never covers the last row.

### 5. Responsive layout (M3 compact window)

Breakpoint: `@media (max-width: 600px)` (M3 "compact" width class).

- `.entry` flips from a side-by-side row to a column: header region on
  top, action cluster wraps onto its own row below.
- Action links/buttons get padding so each is a ≥ 48px-tall touch target
  on compact (currently `padding: 0; font-size: .85rem` — too small for
  touch per M3).
- Title may wrap (drop `nowrap`); page padding tightens; `.page`
  `max-width` is already fine.
- Detail `<dl>` is two-column on ≥ 600px, single-column (label above
  value) on compact.

### 6. i18n

Add keys to `src/lib/i18n/en.ts` (and the same keys to `de.ts`, `es.ts`,
`fr.ts` — English text is acceptable as the placeholder if the locale
lacks a translation; will confirm the fallback behavior in
`src/lib/i18n/index.ts` during implementation):

- `queue.action.expand` / `queue.action.collapse` (chevron aria-label)
- `queue.detail.content` ("Task content")
- `queue.detail.noContent` ("This task has no content.")
- `queue.column.created` ("Created") — only if not already present.

All other labels reuse existing `queue.column.*` keys.

### 7. Tests

Per the "new features require tests" rule, propose a Playwright E2E on
`/queue` (the repo already uses Playwright): seed one task with a known
body, assert the body is hidden initially, click the row, assert the body
+ a metadata label are visible, click again, assert it collapses. If queue
seeding in the E2E harness proves disproportionately heavy, fall back to a
focused component/unit test of the group/expand logic. Test scope to be
confirmed at review.

## Risks / notes

- Single-file change (`+page.svelte`) plus small i18n additions — low blast
  radius, fully reversible, no shared components touched.
- shadcn-svelte components under `src/lib/components/ui/` are **not**
  touched (project rule).
- Verification: run the dev server and exercise expand/collapse + a
  narrow viewport in the browser before declaring done; run typecheck +
  existing tests before any push.
