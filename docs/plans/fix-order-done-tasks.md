# Fix order of done tasks + make the section collapsible

## Context

The "Abgeschlossen" (Completed) section on the queue page currently lists
done / failed / cancelled tasks in whatever order the loader hands them
back — there is no explicit sort, so the most recently finished task is
not guaranteed to be on top. After a few completions the list also takes
up a lot of vertical space even though the user usually only cares about
running / ready / blocked / backlog work.

Two small fixes:

1. Sort the completed bucket descending by completion time so the last
   completed (or cancelled) task is at the top.
2. Let the user collapse the whole section. Default to collapsed, persist
   the open/closed state in `localStorage` so it survives reloads.

## Files to change

Only one file needs editing:

- `src/routes/queue/+page.svelte` — grouping logic + section markup.

The task data already carries the field we need (`completed_at`), so no
DB / loader / type changes.

## Implementation

### 1. Sort completed entries by completion time (desc)

In `groupEntries()` at `src/routes/queue/+page.svelte:50-89`, the
`completed` array is populated in source order. Sort it before returning.

- Sort key: `completed_at` desc, with `updated_at` as fallback when
  `completed_at` is null (defensive — the column is nullable per
  `QueueEntryRow` in `src/lib/server/db/types.ts:271`, and an older row
  could conceivably be missing it). Use `??` to fall back.
- Apply the sort only to the `completed` array — other buckets keep
  whatever ordering the loader provides (priority / created_at), which
  matches their existing UX.

Sketch:

```ts
completed.sort(
  (a, b) => (b.completed_at ?? b.updated_at) - (a.completed_at ?? a.updated_at)
);
```

### 2. Make the "Abgeschlossen" section collapsible

The section block lives at `src/routes/queue/+page.svelte:701-710`. The
codebase already has a custom inline expand/collapse pattern for task
rows (lines 126-138 and 586) using `svelte/transition`'s `slide` —
reuse the same approach for visual consistency instead of pulling in a
new shadcn component.

State + persistence:

- Add a `let completedOpen = $state(false);` (default collapsed).
- On mount (`$effect`, gated by `typeof localStorage !== 'undefined'` so
  SSR doesn't choke), read `localStorage.getItem('queue.completed.open')`
  and hydrate the state if the key exists.
- Wrap writes in a separate `$effect` that calls
  `localStorage.setItem('queue.completed.open', completedOpen ? '1' : '0')`
  whenever the value changes.
- Storage key: `queue.completed.open` (namespaced, matches the
  `queue.section.*` i18n key style already used).

Markup:

- Turn the `<h2>` into a `<button type="button">` that toggles
  `completedOpen`. Style it to look like the existing `<h2>` (no
  background, inherit font) so the visual hierarchy stays identical to
  the other section headers — only this one gets a chevron + click
  affordance.
- Add `aria-expanded={completedOpen}` and `aria-controls="completed-list"`
  on the button; give the `<ul>` `id="completed-list"`.
- Render a chevron span next to the count (▸ when collapsed, ▾ when
  open) — same pattern used in `taskRow` at line 586.
- Wrap the `<ul class="entries entries-dim">` in
  `{#if completedOpen}` with `transition:slide={{ duration: 150 }}`,
  matching the row-expand animation already used in this file.
- The count `({grouped.completed.length})` stays visible in the header
  so the user knows how many done tasks are hidden when collapsed.

### 3. Out of scope

- The other section headers (Running / Ready / Blocked / Backlog) stay
  as plain `<h2>` — only "Completed" gets the toggle, since it's the
  only one that grows unbounded over time.
- No new translation keys: the existing `queue.section.completed` label
  is reused on the toggle button.

## Verification

1. `pnpm dev` and open `/queue`.
2. Confirm the "Abgeschlossen" section header is now a chevron toggle
   and the list is hidden by default.
3. Expand it. Verify the topmost row is the task that most recently
   transitioned to done / failed / cancelled. Cross-check against
   `completed_at` in the DB or the detail panel timestamps.
4. Mark another task as cancelled / let one finish. Refresh the page —
   the new entry should appear at the top of the list.
5. Toggle the section open, reload — it should remain open. Toggle
   closed, reload — it should remain closed.
6. Keyboard: tab to the header, press Enter / Space — the section
   toggles; `aria-expanded` flips.
7. Run `pnpm check` (Svelte/TS) and `pnpm test` to confirm nothing else
   broke.
