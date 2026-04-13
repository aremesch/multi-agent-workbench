/**
 * i18n core — hand-rolled, ~100 keys, no external deps.
 *
 * Usage:
 *   Server:  t(locals.locale, 'login.error.required')
 *   Client:  via useT() from '$lib/client/i18n.svelte.ts'
 */

import en, { type TranslationKey } from './en';
import de from './de';
import fr from './fr';
import es from './es';

export type Locale = 'en' | 'de' | 'fr' | 'es';

export const SUPPORTED_LOCALES: Locale[] = ['en', 'de', 'fr', 'es'];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_SETTING_KEY = 'ui.locale';

/** Native-language names shown in the locale picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Fran\u00e7ais',
  es: 'Espa\u00f1ol'
};

const dictionaries: Record<Locale, Record<string, string>> = {
  en,
  de: { ...en, ...de },
  fr: { ...en, ...fr },
  es: { ...en, ...es }
};

/**
 * Parse a raw value (from user_settings JSON) into a valid Locale.
 * Returns DEFAULT_LOCALE if the value is null, empty, or unrecognised.
 */
export function parseLocale(raw: string | null): Locale {
  if (!raw) return DEFAULT_LOCALE;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === 'string' && SUPPORTED_LOCALES.includes(v as Locale)) {
      return v as Locale;
    }
  } catch {
    // not valid JSON — try raw string
    if (SUPPORTED_LOCALES.includes(raw as Locale)) return raw as Locale;
  }
  return DEFAULT_LOCALE;
}

/**
 * Best-effort locale from an Accept-Language header value.
 * Picks the first supported language tag (ignoring region subtags).
 */
export function detectLocale(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  // Split on comma, strip quality weights, extract primary subtag.
  const tags = acceptLanguage.split(',').map((s) => s.split(';')[0]!.trim().split('-')[0]!.toLowerCase());
  for (const tag of tags) {
    if (SUPPORTED_LOCALES.includes(tag as Locale)) return tag as Locale;
  }
  return DEFAULT_LOCALE;
}

/**
 * Translate a key, with optional {placeholder} interpolation.
 * Falls back to English, then to the raw key if nothing matches.
 */
export function t(
  locale: Locale,
  key: TranslationKey | string,
  params?: Record<string, string | number>
): string {
  const dict = dictionaries[locale] ?? dictionaries.en;
  let msg = dict[key] ?? dictionaries.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v));
    }
  }
  return msg;
}

export type { TranslationKey };
