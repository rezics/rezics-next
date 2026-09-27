import { create, parseAcceptLanguage } from 'native-i18n';
import { resources } from './resources.ts';

export const LOCALE_COOKIE = 'rezics_locale';
export const uiLocales = ['en', 'zh-CN'] as const;
export type UiLocale = (typeof uiLocales)[number];
export const i18n = create(resources);

function isUiLocale(value: unknown): value is UiLocale {
  return uiLocales.includes(value as UiLocale);
}

/** The Accounts site is not indexed, so its locale comes from the locale
 * cookie (which `?hl=` sets), then Accept-Language. */
export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null): UiLocale {
  if (isUiLocale(cookieValue)) return cookieValue;
  return i18n.matchLocale(parseAcceptLanguage(acceptLanguage));
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
  const chosen = isUiLocale(hl) ? hl
    : hints.length && !isUiLocale(cookieValue(current, LOCALE_COOKIE)) ? i18n.matchLocale(hints)
      : undefined;
  if (!chosen) return { request };
  const headers = new Headers(request.headers);
  headers.set('cookie', withCookie(current, LOCALE_COOKIE, chosen));
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return { request: new Request(request, { headers }), setCookie: isUiLocale(hl)
    ? `${LOCALE_COOKIE}=${hl}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}` : undefined };
}
