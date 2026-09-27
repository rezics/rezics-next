import { cookies, headers } from 'next/headers';
import { i18n, LOCALE_COOKIE, resolveLocale, type UiLocale } from './locale.ts';

export const getTranslation = i18n.getTranslation;

export async function requestLocale(): Promise<UiLocale> {
  const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
  return resolveLocale(jar.get(LOCALE_COOKIE)?.value, requestHeaders.get('accept-language'));
}
