/** Interface locales. English is the fallback and the authoring contract. */
export const uiLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
export type UiLocale = (typeof uiLocales)[number];

export const localeNames: Record<UiLocale, string> = {
  en: 'English', 'zh-Hant': '繁體中文', 'zh-Hans': '简体中文', ja: '日本語',
  ko: '한국어', de: 'Deutsch', fr: 'Français', es: 'Español',
};

export function isUiLocale(value: string): value is UiLocale {
  return (uiLocales as readonly string[]).includes(value);
}

export function localeText(values: { en: string } & Partial<Record<Exclude<UiLocale, 'en'>, string>>):
  Record<UiLocale, string> {
  return Object.fromEntries(uiLocales.map(locale => [locale, values[locale] ?? values.en])) as Record<UiLocale, string>;
}

/**
 * A feature's interface strings. English defines the shape; each translated
 * key must keep the English value type (including `insert` and `plural`).
 * Missing keys use English individually while translation work continues.
 * Export the result as `messages` from `features/<name>/messages.ts` and add one
 * line for it to `i18n/catalogs.ts`.
 */
export function defineMessages<T extends object>(catalog: { en: T } & {
  [Locale in Exclude<UiLocale, 'en'>]?: Partial<NoInfer<T>> }): Record<UiLocale, T> {
  return Object.fromEntries(uiLocales.map(locale => [locale,
    locale === 'en' ? catalog.en : { ...catalog.en, ...catalog[locale] }])) as Record<UiLocale, T>;
}
