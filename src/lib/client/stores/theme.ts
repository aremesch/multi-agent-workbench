import { writable } from 'svelte/store';
import { DEFAULT_THEME, type ThemeId } from '$lib/shared/dashboard';

/**
 * Client-side store holding the active theme id. Kept in sync with
 * `<html data-theme="...">` so any component can both read and mutate
 * the active theme without re-rendering the whole layout.
 */
export const currentTheme = writable<ThemeId>(DEFAULT_THEME);

function applyToDocument(id: ThemeId): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', id);
  }
}

export function initTheme(id: ThemeId): void {
  currentTheme.set(id);
  applyToDocument(id);
}

export async function setTheme(id: ThemeId): Promise<void> {
  currentTheme.set(id);
  applyToDocument(id);
  try {
    await fetch('/api/user/theme', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: id })
    });
  } catch {
    // Non-fatal — preference will revert on next page load.
  }
}
