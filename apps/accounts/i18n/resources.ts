import { defineResources } from 'native-i18n';
import { uiLocales, type UiLocale } from './define.ts';

type Catalog<T> = { [Locale in UiLocale]: () => Promise<T> };
type TranslationLoaders<T> = Partial<Record<Exclude<UiLocale, 'en'>, () => Promise<Partial<T>>>>;

/** Each locale loads English first, then overlays only its translated keys. */
function catalog<T extends object>(english: () => Promise<T>, translations: TranslationLoaders<T>): Catalog<T> {
  return Object.fromEntries(uiLocales.map(locale => [locale, async () => {
    const source = await english();
    if (locale === 'en') return source;
    return { ...source, ...await translations[locale]?.() };
  }])) as Catalog<T>;
}

const catalogs = {
  common: catalog(() => import('../features/shell/messages/en.ts').then(module => module.default), {
    'zh-Hans': () => import('../features/shell/messages/zh-Hans.ts').then(module => module.default),
    'zh-Hant': () => import('../features/shell/messages/zh-Hant.ts').then(module => module.default),
    ja: () => import('../features/shell/messages/ja.ts').then(module => module.default),
    ko: () => import('../features/shell/messages/ko.ts').then(module => module.default),
    de: () => import('../features/shell/messages/de.ts').then(module => module.default),
    fr: () => import('../features/shell/messages/fr.ts').then(module => module.default),
    es: () => import('../features/shell/messages/es.ts').then(module => module.default),
  }),
  auth: catalog(() => import('../features/auth/messages/en.ts').then(module => module.default), {
    'zh-Hans': () => import('../features/auth/messages/zh-Hans.ts').then(module => module.default),
    'zh-Hant': () => import('../features/auth/messages/zh-Hant.ts').then(module => module.default),
    ja: () => import('../features/auth/messages/ja.ts').then(module => module.default),
    ko: () => import('../features/auth/messages/ko.ts').then(module => module.default),
    de: () => import('../features/auth/messages/de.ts').then(module => module.default),
    fr: () => import('../features/auth/messages/fr.ts').then(module => module.default),
    es: () => import('../features/auth/messages/es.ts').then(module => module.default),
  }),
  consent: catalog(() => import('../features/consent/messages/en.ts').then(module => module.default), {
    'zh-Hans': () => import('../features/consent/messages/zh-Hans.ts').then(module => module.default),
    'zh-Hant': () => import('../features/consent/messages/zh-Hant.ts').then(module => module.default),
    ja: () => import('../features/consent/messages/ja.ts').then(module => module.default),
    ko: () => import('../features/consent/messages/ko.ts').then(module => module.default),
    de: () => import('../features/consent/messages/de.ts').then(module => module.default),
    fr: () => import('../features/consent/messages/fr.ts').then(module => module.default),
    es: () => import('../features/consent/messages/es.ts').then(module => module.default),
  }),
  account: catalog(() => import('../features/account/messages/en.ts').then(module => module.default), {
    'zh-Hans': () => import('../features/account/messages/zh-Hans.ts').then(module => module.default),
    'zh-Hant': () => import('../features/account/messages/zh-Hant.ts').then(module => module.default),
    ja: () => import('../features/account/messages/ja.ts').then(module => module.default),
    ko: () => import('../features/account/messages/ko.ts').then(module => module.default),
    de: () => import('../features/account/messages/de.ts').then(module => module.default),
    fr: () => import('../features/account/messages/fr.ts').then(module => module.default),
    es: () => import('../features/account/messages/es.ts').then(module => module.default),
  }),
  admin: catalog(() => import('../features/admin/messages/en.ts').then(module => module.default), {
    'zh-Hans': () => import('../features/admin/messages/zh-Hans.ts').then(module => module.default),
    'zh-Hant': () => import('../features/admin/messages/zh-Hant.ts').then(module => module.default),
    ja: () => import('../features/admin/messages/ja.ts').then(module => module.default),
    ko: () => import('../features/admin/messages/ko.ts').then(module => module.default),
    de: () => import('../features/admin/messages/de.ts').then(module => module.default),
    fr: () => import('../features/admin/messages/fr.ts').then(module => module.default),
    es: () => import('../features/admin/messages/es.ts').then(module => module.default),
  }),
};

type Catalogs = typeof catalogs;
type LocaleLoaders<Locale extends UiLocale> = {
  [Namespace in keyof Catalogs]: Catalogs[Namespace][Locale];
};

function localeLoaders<Locale extends UiLocale>(locale: Locale): LocaleLoaders<Locale> {
  return Object.fromEntries(Object.entries(catalogs).map(([namespace, load]) =>
    [namespace, load[locale]])) as LocaleLoaders<Locale>;
}

export const resources = defineResources({
  fallbackLocale: 'en',
  loaders: Object.fromEntries(uiLocales.map(locale => [locale, localeLoaders(locale)])) as {
    [Locale in UiLocale]: LocaleLoaders<Locale> },
});
