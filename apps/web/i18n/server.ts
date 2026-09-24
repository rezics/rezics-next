import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, i18n, resolveLocale } from './locale.ts';

export async function requestLocale() {
  const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
  return resolveLocale(jar.get(LOCALE_COOKIE)?.value, requestHeaders.get('accept-language'));
}

export const getTranslation = i18n.getTranslation;
