/**
 * Shared constants/types for the dashboard layout. Kept out of the SvelteKit
 * `+server.ts` file because that module is only allowed to export handler
 * symbols (GET/POST/…) — any extra named export triggers a build-time error.
 */

// v3: uniform "small computer screen" sizing — every fresh card gets
// a 3×2 grid box on a square-celled grid (~16:10 landscape), ignoring
// terminal content aspect. Bumping the key invalidates every v1/v2
// layout so old cards reflow into the new uniform default on next load.
export const DASHBOARD_LAYOUT_KEY = 'dashboard.layout.v3';

// Per-repo dashboards each get their own gridstack arrangement, keyed by
// repo id. Matches the allow-list pattern enforced server-side.
export function repoDashboardLayoutKey(repoId: string): string {
  return `dashboard.layout.repo.${repoId}.v1`;
}

// Whitelist of accepted layout keys: the global dashboard or a per-repo
// dashboard whose suffix is a UUID-shaped string. Used by the layout PUT
// endpoint to bound what an authenticated user can write into
// `user_settings`.
const REPO_LAYOUT_KEY_RE = /^dashboard\.layout\.repo\.[a-zA-Z0-9_-]+\.v\d+$/;
export function isValidLayoutKey(key: string): boolean {
  return key === DASHBOARD_LAYOUT_KEY || REPO_LAYOUT_KEY_RE.test(key);
}

export const SIDEBAR_COLLAPSED_KEY = 'ui.sidebar.collapsed';
