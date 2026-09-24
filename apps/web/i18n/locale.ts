import { create, parseAcceptLanguage } from 'native-i18n';
import { resources, type UiLocale } from './resources.ts';

export const LOCALE_COOKIE = 'rezics_locale';
export const i18n = create(resources);

export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null): UiLocale {
  if (cookieValue === 'en' || cookieValue === 'zh-CN') return cookieValue;
  return i18n.matchLocale(parseAcceptLanguage(acceptLanguage));
}
