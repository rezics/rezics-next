import { uiLocales, type UiLocale } from './locales.ts';

/**
 * A page's copy. English defines the shape and every other locale must supply
 * the whole of it: a missing key is a type error here and a failing test in
 * `tests/catalogs.test.ts`, because the public site never falls back to English.
 */
export function defineCopy<T extends object>(
  catalog: { en: T } & { [Locale in Exclude<UiLocale, 'en'>]: NoInfer<T> },
): Record<UiLocale, T> {
  return Object.fromEntries(uiLocales.map((locale) => [locale, catalog[locale]])) as Record<
    UiLocale,
    T
  >;
}
