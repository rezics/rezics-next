import {
  cookieName,
  defineCustomServerStrategy,
  extractLocaleFromRequestWithStrategies,
  isLocale,
  locales,
  type Locale,
} from './paraglide/runtime.js';

// Names are presentation only. The generated supported list controls available choices.
export const localeNames: Record<Locale, string> = {
  en: 'English',
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
};

/** Read only this interface cookie, including when persistence silently fails. */
export function storedInterfaceLocale(): Locale | undefined {
  try {
    const value = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    return isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function installAuthLocaleNegotiation() {
  defineCustomServerStrategy('custom-accept-language', {
    getLocale(request) {
      if (!request) return undefined;
      try {
        return extractLocaleFromRequestWithStrategies(request, ['cookie']);
      } catch {
        // Continue to weighted Accept-Language negotiation when the cookie has no supported locale.
      }
      return matchUiLocaleTag(request.headers.get('accept-language'));
    },
  });
}

export function matchUiLocaleTag(header: string | null): string | undefined {
  const entries = (header ?? '').split(',').map((part, index) => ({
    tag: part.split(';')[0]!.trim().toLowerCase(),
    index,
    quality: Number(/;\s*q=([0-9.]+)/i.exec(part)?.[1] ?? 1),
  }));
  entries.sort((left, right) => right.quality - left.quality || left.index - right.index);
  for (const { tag, quality } of entries) {
    if (quality <= 0) continue;
    const exact = locales.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const [language, ...subtags] = tag.split('-');
    if (language === 'zh')
      return subtags.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh-Hans';
    const base = locales.find((locale) => locale.toLowerCase() === language);
    if (base) return base;
  }
  return undefined;
}
