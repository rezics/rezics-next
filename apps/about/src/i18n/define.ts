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

const untranslated = new WeakSet<object>();

/**
 * Copy written in English that has not been translated yet (G-482 translates it
 * and replaces this call with `defineCopy`). Every locale gets the English text,
 * and pages that read it mark their content `lang="en"` through `contentLanguage`,
 * so no page claims a language its text is not in. `tests/catalogs.test.ts` names
 * every such catalog, so the state cannot spread or ship unnoticed.
 */
export function defineEnglishCopy<T extends object>(en: T): Record<UiLocale, T> {
  const catalog = Object.fromEntries(uiLocales.map((locale) => [locale, en])) as Record<
    UiLocale,
    T
  >;
  untranslated.add(catalog);
  return catalog;
}

export function awaitsTranslation(catalog: object): boolean {
  return untranslated.has(catalog);
}

/** The language a page's content is in: its locale, or English while any catalog it reads awaits translation. */
export function contentLanguage(locale: UiLocale, catalogs: readonly object[]): UiLocale {
  return locale !== 'en' && catalogs.some(awaitsTranslation) ? 'en' : locale;
}
