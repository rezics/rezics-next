/**
 * The interface locales, the same eight as `apps/web/i18n/define.ts` (a test
 * keeps them equal). English is the authoring contract; every other locale
 * must complete every catalog, unlike the app, which falls back per key.
 */
export const uiLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
export type UiLocale = (typeof uiLocales)[number];

export const localeNames: Record<UiLocale, string> = {
  en: 'English',
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
};

/** Writing direction of each locale's script; all current locales run left to right. */
export const localeDirection: Record<UiLocale, 'ltr' | 'rtl'> = {
  en: 'ltr',
  'zh-Hant': 'ltr',
  'zh-Hans': 'ltr',
  ja: 'ltr',
  ko: 'ltr',
  de: 'ltr',
  fr: 'ltr',
  es: 'ltr',
};

/** OpenGraph locale codes (language_TERRITORY). */
export const openGraphLocale: Record<UiLocale, string> = {
  en: 'en_US',
  'zh-Hant': 'zh_TW',
  'zh-Hans': 'zh_CN',
  ja: 'ja_JP',
  ko: 'ko_KR',
  de: 'de_DE',
  fr: 'fr_FR',
  es: 'es_ES',
};

export const defaultLocale: UiLocale = 'en';
export const LOCALE_COOKIE = 'rezics_locale';
export const THEME_COOKIE = 'rezics_theme';

export function isUiLocale(value: string): value is UiLocale {
  return (uiLocales as readonly string[]).includes(value);
}

/** Match a stored choice or a browser language range to a supported locale. */
export function matchLocaleTag(value: string | undefined): UiLocale | undefined {
  if (!value) return undefined;
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(value.replaceAll('_', '-'));
  } catch {
    return undefined;
  }
  const canonical = locale.toString();
  if (isUiLocale(canonical)) return canonical;
  if (locale.language === 'zh') {
    return locale.script === 'Hant' || ['TW', 'HK', 'MO'].includes(locale.region ?? '')
      ? 'zh-Hant'
      : 'zh-Hans';
  }
  return isUiLocale(locale.language) ? locale.language : undefined;
}

/** Language ranges of an Accept-Language header, highest quality first. */
export function parseAcceptLanguage(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [range = '', ...params] = part.trim().split(';');
      const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
      const quality = q ? Number(q.slice(2)) : 1;
      return { range: range.trim(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((item) => item.range && item.range !== '*' && item.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((item) => item.range);
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

/** The cookie choice wins, then the browser's language ranges, then English. */
export function negotiateLocale(
  cookieHeader: string | null,
  acceptLanguage: string | null,
): UiLocale {
  const stored = matchLocaleTag(readCookie(cookieHeader, LOCALE_COOKIE));
  if (stored) return stored;
  for (const range of parseAcceptLanguage(acceptLanguage)) {
    const matched = matchLocaleTag(range);
    if (matched) return matched;
  }
  return defaultLocale;
}
