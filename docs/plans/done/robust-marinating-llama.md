# Sidebar: fully hide when collapsed

## Context

The collapsed sidebar currently shrinks to `1.75rem`, leaving a small strip
with just the expand chevron. The user wants it to disappear completely
(`width: 0`) and the expand toggle to move into the top app bar.

## Changes

### 1. `RepoTreeSidebar.svelte` — collapse to `width: 0`

- Change `.sidebar.collapsed` from `width: 1.75rem; flex: 0 0 1.75rem` to
  `width: 0; flex: 0 0 0; border-right: none;`.
- Remove the `<header class="head">` block that currently contains the
  collapse/expand button and "Workspace" label. The toggle responsibility
  moves to the layout.
- Add a new "Workspace" label inline in the tree nav (or keep it as the
  first item) so it's still visible when expanded.
- The sidebar still renders the expand/collapse state internally via
  `isCollapsed`, but the **toggle button is removed** from this component.
  Instead, expose the toggle via a callback prop (`onToggle`) or let the
  layout own the state and pass `collapsed` as a reactive prop.

**Simpler approach — layout owns the state:**
- Remove `isCollapsed` local state and the `toggleCollapsed` function from
  the sidebar. The sidebar becomes a pure display component that takes
  `collapsed: boolean` as a prop.
- The layout owns `isCollapsed` state, passes it down, and renders the
  toggle button in the app bar.
- The sidebar persists preference via the layout (layout calls the
  `/api/user/sidebar-state` endpoint on toggle).

### 2. `+layout.svelte` — add expand toggle to app bar

- Add a sidebar toggle button to the left side of the top header bar
  (before the "Multi-Agent Workbench" link). Use the same chevron icon
  (right-pointing when collapsed, left-pointing when expanded).
- Own the `isCollapsed` state (initialized from `data.sidebar.collapsed`).
- On click, flip `isCollapsed` and PUT to `/api/user/sidebar-state`.
- Pass `isCollapsed` to `<RepoTreeSidebar collapsed={isCollapsed} />`.

### 3. Files to modify

| File | What changes |
|------|-------------|
| `src/lib/client/components/RepoTreeSidebar.svelte` | Remove header with toggle button, remove local collapse state & API call, collapse to `width: 0` |
| `src/routes/+layout.svelte` | Add sidebar toggle button in app bar, own collapse state & persistence |

## Verification

1. `pnpm check` — 0 errors
2. Visual: sidebar fully disappears when collapsed, no strip remains
3. Toggle button in the app bar opens/closes sidebar with smooth transition
4. Sidebar state persists across page loads (API call still fires)
5. Treeview navigation still works (click repo → dashboard, click agent → modal)
