import { catalogs } from './messages/index.ts';
import { contentLanguage } from './define.ts';
import type { UiLocale } from './locales.ts';

/** English page names for share images, which are Latin-only. */
export function englishPage(page: keyof typeof catalogs.site.en.pages): {
  name: string;
  summary: string;
} {
  return catalogs.site.en.pages[page];
}

/** Localized copy of a named catalog. */
export function copy<K extends keyof typeof catalogs>(
  name: K,
  locale: UiLocale,
): (typeof catalogs)[K][UiLocale] {
  return catalogs[name][locale];
}

/** The language a page's content is in, given the catalogs it reads: English while any awaits translation. */
export function pageLanguage(locale: UiLocale, ...names: (keyof typeof catalogs)[]): UiLocale {
  return contentLanguage(
    locale,
    names.map((name) => catalogs[name]),
  );
}
