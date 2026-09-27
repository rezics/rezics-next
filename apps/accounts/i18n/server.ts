import { cookies, headers } from 'next/headers';
import { readSession } from '../features/api/server.ts';
import { i18n, LOCALE_COOKIE, resolveLocale, type UiLocale } from './locale.ts';

export const getTranslation = i18n.getTranslation;

/** The browser's chosen language, then the signed-in account's, then the
 * browser's languages. The session read is the page's own, cached per request. */
export async function requestLocale(): Promise<UiLocale> {
  const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
  const chosen = jar.get(LOCALE_COOKIE)?.value;
  const session = chosen || !requestHeaders.get('cookie') ? undefined : await readSession();
  return resolveLocale(chosen ?? (session?.status === 'ok' ? session.data.user.locale ?? undefined : undefined),
    requestHeaders.get('accept-language'));
}
