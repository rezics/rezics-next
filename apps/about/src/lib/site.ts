import { defaultLocale, uiLocales, type UiLocale } from '../i18n/locales.ts';
import { pagePath, type PageId } from '../pages.ts';

/** The site's public origin, from `astro.config.ts` (`ABOUT_SITE_URL`). */
export function absoluteUrl(path: string, site: URL | string | undefined): string {
  return new URL(path, site ?? 'https://rezics.com').toString();
}

/** The same page in every locale, plus `x-default`, for hreflang and the sitemap. */
export function alternates(
  page: PageId,
  site: URL | string | undefined,
): { hreflang: string; href: string }[] {
  return [
    ...uiLocales.map((locale) => ({
      hreflang: locale,
      href: absoluteUrl(pagePath(locale, page), site),
    })),
    { hreflang: 'x-default', href: absoluteUrl(pagePath(defaultLocale, page), site) },
  ];
}

/** `getStaticPaths` for a locale-prefixed page: one path per locale. */
export function localePaths(): { params: { locale: UiLocale } }[] {
  return uiLocales.map((locale) => ({ params: { locale } }));
}
