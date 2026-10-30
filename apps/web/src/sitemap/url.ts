import { locales } from '../paraglide/runtime.js';
import type { PagePaths } from '../shell/head.ts';
import type { SitemapFamily } from './pack.ts';

/** Reuse the canonical reader's paths, including its current identity, language fallback and selected view. */
export function sitemapFamilyFromPagePaths(paths: PagePaths, lastModified?: string): SitemapFamily {
  return {
    paths: Object.fromEntries(
      locales.map((locale) => {
        const path = paths[locale];
        if (
          !path.startsWith('/') ||
          path.startsWith('//') ||
          /[?#]/u.test(path) ||
          locales.some((language) => path === `/${language}` || path.startsWith(`/${language}/`))
        )
          throw new Error(`Invalid canonical page path for ${locale}`);
        return [locale, `/${locale}${path === '/' ? '' : path}`];
      }),
    ) as PagePaths,
    ...(lastModified === undefined ? {} : { lastmod: lastModified }),
  };
}

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
