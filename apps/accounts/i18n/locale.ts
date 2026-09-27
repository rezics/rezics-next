import { create, parseAcceptLanguage } from 'native-i18n';
import { localeNames, uiLocales, type UiLocale } from './define.ts';
import { resources } from './resources.ts';

export { localeNames, uiLocales };
export type { UiLocale };
export const LOCALE_COOKIE = 'rezics_locale';
export const i18n = create(resources);

/** Match stored choices and browser language ranges to the supported locales. */
export function matchUiLocaleTag(value: string | undefined): UiLocale | undefined {
  if (!value) return undefined;
  let locale: Intl.Locale;
  try { locale = new Intl.Locale(value.replaceAll('_', '-')); }
  catch { return undefined; }
  const canonical = locale.toString();
  if ((uiLocales as readonly string[]).includes(canonical)) return canonical as UiLocale;
  if (locale.language === 'zh') {
    return locale.script === 'Hant' || ['TW', 'HK', 'MO'].includes(locale.region ?? '')
      ? 'zh-Hant' : 'zh-Hans';
  }
  return (uiLocales as readonly string[]).includes(locale.language) ? locale.language as UiLocale : undefined;
}

/** The Accounts site is not indexed, so its locale comes from the locale
 * cookie (which `?hl=` sets), then Accept-Language. */
export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null): UiLocale {
  const stored = matchUiLocaleTag(cookieValue);
  if (stored) return stored;
  for (const tag of parseAcceptLanguage(acceptLanguage)) {
    const matched = matchUiLocaleTag(tag);
    if (matched) return matched;
  }
  return 'en';
}

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

function withCookie(header: string | null, name: string, value: string): string {
  const kept = (header ?? '').split(';').map(part => part.trim())
    .filter(part => part && !part.startsWith(`${name}=`));
  return [...kept, `${name}=${value}`].join('; ');
}

/** `?hl=` selects the interface language and remembers it. An OAuth request's
 * `ui_locales` applies to that page only and never overrides a chosen language. */
export function applyLocaleParameter(request: Request): { request: Request; setCookie?: string } {
  if (request.method !== 'GET') return { request };
  const url = new URL(request.url);
  const hl = url.searchParams.get('hl');
  const hints = (url.searchParams.get('ui_locales') ?? '').split(' ').filter(Boolean);
  const current = request.headers.get('cookie');
  const requested = matchUiLocaleTag(hl ?? undefined);
  const stored = matchUiLocaleTag(cookieValue(current, LOCALE_COOKIE));
  const hinted = hints.map(matchUiLocaleTag).find((locale): locale is UiLocale => locale !== undefined);
  const chosen = requested ?? (!stored ? hinted : undefined);
  if (!chosen) return { request };
  const headers = new Headers(request.headers);
  headers.set('cookie', withCookie(current, LOCALE_COOKIE, chosen));
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return { request: new Request(request, { headers }), setCookie: requested
    ? `${LOCALE_COOKIE}=${requested}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}` : undefined };
}
