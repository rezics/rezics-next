/** Account interface locales. English is the per-key fallback. */
export const uiLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
export type UiLocale = (typeof uiLocales)[number];

export const localeNames: Record<UiLocale, string> = {
  en: 'English', 'zh-Hant': '繁體中文', 'zh-Hans': '简体中文', ja: '日本語',
  ko: '한국어', de: 'Deutsch', fr: 'Français', es: 'Español',
};
