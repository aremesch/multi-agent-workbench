# Fix all-page scrolling — pin sidebar & header globally

## Context

Across all views (archive, dashboards, settings, etc.), scrolling the page
also scrolls the sidebar and title bar. Only the main content area should
scroll; the header and sidebar must stay fixed.

## Root cause

In `src/routes/+layout.svelte:77`, the outer container uses `min-h-screen`
which lets it grow beyond the viewport. When any page's content is tall,
the *entire page* scrolls — header, sidebar, and all.

The content `<section>` at line 169 has no overflow constraint, so content
pushes the page taller instead of scrolling internally.

## Changes

**File: `src/routes/+layout.svelte`** (only file changed)

1. **Line 77** — Lock the outer container to viewport height:
   ```diff
   - <div class="flex min-h-screen flex-col bg-surface text-on-surface">
   + <div class="flex h-screen flex-col bg-surface text-on-surface overflow-hidden">
   ```

2. **Line 169** — Make the content section the sole scroll container:
   ```diff
   - <section class="min-w-0 flex-1 p-4">
   + <section class="min-w-0 flex-1 overflow-y-auto p-4">
   ```

Two class changes, one file. This is at the root layout level so it
applies to **every** page: main dashboard, per-repo dashboard, archive,
settings, login, etc. The sidebar already has `overflow-y: auto` on its
`.tree` nav, so it scrolls independently when its own content overflows.

## Verification

1. `pnpm check` — no type errors
2. Archive page with many agents — only content scrolls, header+sidebar pinned
3. Main dashboard / per-repo dashboard — gridstack cards stay within the
   scrollable content area, header+sidebar pinned
4. Settings / login pages — behave normally, no layout breakage
