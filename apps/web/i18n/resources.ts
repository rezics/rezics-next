import { defineResources } from 'native-i18n';
import { catalogs } from './catalogs.ts';
import { uiLocales, type UiLocale } from './define.ts';

export type { UiLocale } from './define.ts';

type Catalogs = typeof catalogs;
type LocaleLoaders<Locale extends UiLocale> = {
  [Namespace in keyof Catalogs]: () => Promise<Awaited<ReturnType<Catalogs[Namespace]>>[Locale]>;
};

/** Splits the per-feature catalogs into native-i18n's locale × namespace loaders. */
function localeLoaders<Locale extends UiLocale>(locale: Locale): LocaleLoaders<Locale> {
  return Object.fromEntries(Object.entries(catalogs).map(([namespace, load]) =>
    [namespace, () => load().then(catalog => catalog[locale])])) as LocaleLoaders<Locale>;
}

export const resources = defineResources({
  fallbackLocale: 'en',
  loaders: Object.fromEntries(uiLocales.map(locale => [locale, localeLoaders(locale)])) as {
    [Locale in UiLocale]: LocaleLoaders<Locale> },
});
