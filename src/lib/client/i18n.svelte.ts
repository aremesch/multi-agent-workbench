/**
 * Svelte-specific i18n helper.
 *
 * Usage inside a .svelte component:
 *   import { useT } from '$lib/client/i18n.svelte';
 *   const t = useT();
 *   // then in template: {t('login.title')}
 */

import { getContext } from 'svelte';
import { t as translate, type Locale, type TranslationKey } from '$lib/i18n';

/**
 * Returns a translation function bound to the current reactive locale
 * (provided via Svelte context by +layout.svelte).
 */
export function useT(): (key: TranslationKey | string, params?: Record<string, string | number>) => string {
  const getLocale = getContext<() => Locale>('maw-locale');
  return (key, params) => translate(getLocale(), key, params);
}
