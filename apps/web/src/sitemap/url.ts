import { locales } from '../paraglide/runtime.js';
import type { PagePaths } from '../shell/head.ts';

/** Feed hrefs include their locale; page heads and pageLinks receive paths below that locale. */
export function sitemapPagePaths(paths: PagePaths): PagePaths {
  return Object.fromEntries(
    locales.map((locale) => {
      const path = paths[locale];
      const prefix = `/${locale}`;
      return [locale, path === prefix ? '/' : path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path];
    }),
  ) as PagePaths;
}
