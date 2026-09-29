import { catalogs } from './messages/index.ts';
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
