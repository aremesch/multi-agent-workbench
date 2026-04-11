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
