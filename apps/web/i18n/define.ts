/** Interface locales. English is the fallback and the authoring contract. */
export const uiLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
export type UiLocale = (typeof uiLocales)[number];

export const localeNames: Record<UiLocale, string> = {
  en: 'English', 'zh-Hant': '繁體中文', 'zh-Hans': '简体中文', ja: '日本語',
  ko: '한국어', de: 'Deutsch', fr: 'Français', es: 'Español',
};

/** Interface copy is left to right in every shipped locale; content keeps the direction of its own language. */
export const interfaceDirection = {
  en: 'ltr', 'zh-Hant': 'ltr', 'zh-Hans': 'ltr', ja: 'ltr', ko: 'ltr', de: 'ltr', fr: 'ltr', es: 'ltr',
} as const satisfies Record<UiLocale, 'ltr' | 'rtl'>;

export function isUiLocale(value: string): value is UiLocale {
  return (uiLocales as readonly string[]).includes(value);
}

/**
 * A feature's interface strings. English defines the shape and every other
 * locale must supply the whole of it. A catalog that is still partial assembles
 * each locale with `withEnglish`; the locale files themselves stay partial so
 * the catalog check can see the gaps. Export the result as `messages` from
 * `features/<name>/messages.ts` and add one line for it to `i18n/catalogs.ts`.
 */
export function defineMessages<T extends object>(
  catalog: { en: T } & { [Locale in Exclude<UiLocale, 'en'>]: NoInfer<T> },
): Record<UiLocale, T> {
  return catalog;
}

/** One complete locale: English, with any translated keys laid over it. */
export function withEnglish<T extends object>(english: T, partial: Partial<T> | undefined): T {
  return { ...english, ...partial } as T;
}

/**
 * The synchronous `Record<UiLocale, string>` shape call sites already index.
 * A missing translation reads English. The per-locale files stay partial.
 */
export function indexCatalog<T extends Record<string, string>>(
  english: T,
  translations: Partial<Record<Exclude<UiLocale, 'en'>, Partial<T>>>,
): { [K in keyof T]: Record<UiLocale, string> } {
  const indexed = {} as { [K in keyof T]: Record<UiLocale, string> };
  for (const key of Object.keys(english) as (keyof T)[]) {
    const fallback = english[key];
    indexed[key] = {
      en: fallback,
      'zh-Hant': translations['zh-Hant']?.[key] ?? fallback,
      'zh-Hans': translations['zh-Hans']?.[key] ?? fallback,
      ja: translations.ja?.[key] ?? fallback,
      ko: translations.ko?.[key] ?? fallback,
      de: translations.de?.[key] ?? fallback,
      fr: translations.fr?.[key] ?? fallback,
      es: translations.es?.[key] ?? fallback,
    };
  }
  return indexed;
}
