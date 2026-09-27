import { uiLocales, type UiLocale } from './define.ts';

type LocaleCatalog<T> = { [Locale in UiLocale]: () => Promise<T> };

function inlineCatalog<T extends Record<UiLocale, object>>(load: () => Promise<T>): LocaleCatalog<T[UiLocale]> {
  return Object.fromEntries(uiLocales.map(locale => [locale, () => load().then(catalog => catalog[locale])])) as
    LocaleCatalog<T[UiLocale]>;
}

function splitCatalog<T extends object>(english: () => Promise<T>, translations: Partial<Record<Exclude<UiLocale, 'en'>,
  () => Promise<Partial<T>>>>): LocaleCatalog<T> {
  return Object.fromEntries(uiLocales.map(locale => [locale, async () => {
    const source = await english();
    return locale === 'en' ? source : { ...source, ...await translations[locale]?.() };
  }])) as LocaleCatalog<T>;
}

// Feature catalogs, one line each, loaded as native-i18n namespaces. Git merges
// this file with the union driver (see .gitattributes), so parallel feature
// branches add their lines without conflicts; keep one entry per line.
export const catalogs = {
  auth: inlineCatalog(() => import('../features/auth/messages.ts').then(module => module.messages)),
  discover: inlineCatalog(() => import('../features/discover/messages.ts').then(module => module.messages)),
  home: splitCatalog(() => import('../features/home/messages.ts').then(module => module.messages), {
    'zh-Hant': () => import('../features/home/messages/zh-Hant.ts').then(module => module.default),
    'zh-Hans': () => import('../features/home/messages/zh-Hans.ts').then(module => module.default),
    ja: () => import('../features/home/messages/ja.ts').then(module => module.default),
    ko: () => import('../features/home/messages/ko.ts').then(module => module.default),
    de: () => import('../features/home/messages/de.ts').then(module => module.default),
    fr: () => import('../features/home/messages/fr.ts').then(module => module.default),
    es: () => import('../features/home/messages/es.ts').then(module => module.default),
  }),
  realm: splitCatalog(() => import('../features/realm/messages.ts').then(module => module.messages), {
    'zh-Hans': () => import('../features/realm/messages/zh-Hans.ts').then(module => module.default),
  }),
  manage: splitCatalog(() => import('../features/manage/messages.ts').then(module => module.messages), {
    'zh-Hant': () => import('../features/manage/messages/zh-Hant.ts').then(module => module.default),
    'zh-Hans': () => import('../features/manage/messages/zh-Hans.ts').then(module => module.default),
    ja: () => import('../features/manage/messages/ja.ts').then(module => module.default),
    ko: () => import('../features/manage/messages/ko.ts').then(module => module.default),
    de: () => import('../features/manage/messages/de.ts').then(module => module.default),
    fr: () => import('../features/manage/messages/fr.ts').then(module => module.default),
    es: () => import('../features/manage/messages/es.ts').then(module => module.default),
  }),
  search: inlineCatalog(() => import('../features/search/messages.ts').then(module => module.messages)),
  shell: splitCatalog(() => import('../features/shell/messages.ts').then(module => module.messages), {
    'zh-Hant': () => import('../features/shell/messages/zh-Hant.ts').then(module => module.default),
    'zh-Hans': () => import('../features/shell/messages/zh-Hans.ts').then(module => module.default),
    ja: () => import('../features/shell/messages/ja.ts').then(module => module.default),
    ko: () => import('../features/shell/messages/ko.ts').then(module => module.default),
    de: () => import('../features/shell/messages/de.ts').then(module => module.default),
    fr: () => import('../features/shell/messages/fr.ts').then(module => module.default),
    es: () => import('../features/shell/messages/es.ts').then(module => module.default),
  }),
  studio: inlineCatalog(() => import('../features/studio/messages.ts').then(module => module.messages)),
  work: inlineCatalog(() => import('../features/work/messages.ts').then(module => module.messages)),
  workPage: inlineCatalog(() => import('../features/work-page/messages.ts').then(module => module.messages)),
  zones: splitCatalog(() => import('../features/zones/messages.ts').then(module => module.messages), {
    'zh-Hans': () => import('../features/zones/messages/zh-Hans.ts').then(module => module.default),
  }),
};
