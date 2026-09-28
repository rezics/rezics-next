import { headers } from 'next/headers';
import { uiLocales, type UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';

/** The localized page's URL as the proxy recorded it, without its query; null for other requests. */
export async function pageUrl(): Promise<URL | null> {
  const url = (await headers()).get('x-rezics-page-url');
  return url ? new URL(url) : null;
}

/**
 * The canonical address of `path` (optionally with a query) in `locale`, and
 * its `hreflang` alternates: the same address in every UI locale. Content
 * languages are a selection in the query, never a path prefix.
 */
export function localeAlternates(origin: string, path: string, locale: UiLocale):
  { canonical: string; languages: Record<string, string> } {
  const address = (choice: UiLocale) => new URL(localizedPath(path, choice), origin).toString();
  return { canonical: address(locale), languages: Object.fromEntries(uiLocales.map(choice => [choice, address(choice)])) };
}
