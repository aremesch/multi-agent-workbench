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

// ─────────────────────────────────────────────────────────────
// Theme preference (persisted in user_settings under `ui.theme`)
// ─────────────────────────────────────────────────────────────

export const THEME_SETTING_KEY = 'ui.theme';

export type ThemeId =
  | 'dark-slate'
  | 'dark-midnight'
  | 'amoled'
  | 'light-default'
  | 'expressive-plum';

export const DEFAULT_THEME: ThemeId = 'dark-slate';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  description: string;
  mode: 'dark' | 'light';
  swatches: { surface: string; primary: string; accent: string };
}

export const ALL_THEMES: ThemeMeta[] = [
  {
    id: 'dark-slate',
    label: 'Slate',
    description: 'Near-black neutrals with a cool blue accent.',
    mode: 'dark',
    swatches: { surface: '#0a0a0a', primary: '#a5d6ff', accent: '#3f4756' }
  },
  {
    id: 'dark-midnight',
    label: 'Midnight',
    description: 'Deep blue-tinged surfaces, softer contrast.',
    mode: 'dark',
    swatches: { surface: '#0d1117', primary: '#89b4ff', accent: '#354066' }
  },
  {
    id: 'amoled',
    label: 'AMOLED',
    description: 'True-black for OLED displays, violet accent.',
    mode: 'dark',
    swatches: { surface: '#000000', primary: '#bb86fc', accent: '#2a2a2a' }
  },
  {
    id: 'light-default',
    label: 'Light',
    description: 'M3 baseline light with a violet primary.',
    mode: 'light',
    swatches: { surface: '#fef7ff', primary: '#6750a4', accent: '#e8def8' }
  },
  {
    id: 'expressive-plum',
    label: 'Expressive Plum',
    description: 'M3 expressive: warm plum surfaces, teal accent.',
    mode: 'dark',
    swatches: { surface: '#1a1220', primary: '#f8b4c0', accent: '#2d5e58' }
  }
];

const THEME_ID_SET = new Set<ThemeId>(ALL_THEMES.map((t) => t.id));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_ID_SET.has(value as ThemeId);
}

export function parseTheme(raw: string | null | undefined): ThemeId {
  if (!raw) return DEFAULT_THEME;
  try {
    const v: unknown = JSON.parse(raw);
    if (isThemeId(v)) return v;
    if (v && typeof v === 'object' && 'theme' in v && isThemeId((v as { theme: unknown }).theme)) {
      return (v as { theme: ThemeId }).theme;
    }
  } catch {
    if (isThemeId(raw)) return raw;
  }
  return DEFAULT_THEME;
}
