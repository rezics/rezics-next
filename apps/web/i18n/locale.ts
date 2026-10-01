import { parseAcceptLanguage } from 'native-i18n';
import { isUiLocale, type UiLocale } from './define.ts';

// Locale paths and matching, shared by the proxy, routes and client components.
// The translator lives in instance.ts, away from this client-reachable module.
export const LOCALE_COOKIE = 'rezics_locale';
const localePrefix = /^\/(en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|[?#]|$)/;

export function pathLocale(pathname: string): UiLocale | null {
  return localePrefix.exec(pathname)?.[1] as UiLocale | undefined ?? null;
}

export function withoutLocale(pathname: string): string {
  const prefix = localePrefix.exec(pathname)?.[0];
  if (!prefix) return pathname;
  const bare = pathname.slice(prefix.length);
  return bare.startsWith('/') ? bare : `/${bare}`;
}

/** Routes backed by locale-prefixed pages; auth and service paths stay at the origin root. */
export function isPublicPagePath(pathname: string): boolean {
  const bare = withoutLocale(pathname);
  return bare === '/' || /^\/(?:authors|concepts|discover|e|isbn|library|manage|notifications|proposals|r|releases|report|search|studio|submit|w|works)(?:\/|$)/.test(bare)
    || bare === '/identity'
    // Profiles, `/@{handle}` (app/[locale]/[handle]).
    || /^\/(?:@|%40)[^/]/.test(bare);
}

/** `/report` and the private case pages under it: no page there may leak its address in a Referer. */
export function isReportPath(pathname: string): boolean {
  return /^\/report(?:\/|$)/.test(withoutLocale(pathname));
}

export function localizedPath(path: string, locale: UiLocale): string {
  const bare = withoutLocale(path);
  return `/${locale}${bare === '/' ? '' : bare.startsWith('/?') || bare.startsWith('/#') ? bare.slice(1) : bare}`;
}

export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null): UiLocale {
  const stored = cookieValue && matchUiLocaleTag(cookieValue);
  if (stored) return stored;
  for (const tag of parseAcceptLanguage(acceptLanguage)) {
    const matched = matchUiLocaleTag(tag);
    if (matched) return matched;
  }
  return 'en';
}

/** Match browser language ranges to the eight interface locales. */
export function matchUiLocaleTag(value: string): UiLocale | undefined {
  let locale: Intl.Locale;
  try { locale = new Intl.Locale(value.replaceAll('_', '-')); }
  catch { return undefined; }
  const canonical = locale.toString();
  if (isUiLocale(canonical)) return canonical;
  if (locale.language === 'zh') {
    return locale.script === 'Hant' || ['TW', 'HK', 'MO'].includes(locale.region ?? '')
      ? 'zh-Hant' : 'zh-Hans';
  }
  return isUiLocale(locale.language) ? locale.language : undefined;
}
