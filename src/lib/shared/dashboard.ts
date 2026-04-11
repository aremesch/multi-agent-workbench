/**
 * Shared constants/types for the dashboard layout. Kept out of the SvelteKit
 * `+server.ts` file because that module is only allowed to export handler
 * symbols (GET/POST/…) — any extra named export triggers a build-time error.
 */

export const DASHBOARD_LAYOUT_KEY = 'dashboard.layout.v1';
