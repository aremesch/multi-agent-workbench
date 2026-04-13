import { writable } from 'svelte/store';
import { DEFAULT_LOCALE, type Locale } from '$lib/i18n';

/**
 * Client-side store holding the active locale. Kept in sync with
 * `<html lang="...">` so any component can read the current locale.
 */
export const currentLocale = writable<Locale>(DEFAULT_LOCALE);

function applyToDocument(locale: Locale): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', locale);
  }
}

export function initLocale(locale: Locale): void {
  currentLocale.set(locale);
  applyToDocument(locale);
}

export async function setLocale(locale: Locale): Promise<void> {
  currentLocale.set(locale);
  applyToDocument(locale);
  try {
    await fetch('/api/user/locale', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale })
    });
  } catch {
    // Non-fatal — preference will revert on next page load.
  }
}
