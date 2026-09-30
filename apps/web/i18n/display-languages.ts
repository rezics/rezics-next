import { canonicalLanguage, readerLanguages } from '@rezics/main/language';
import { pathLocale } from './locale.ts';

export const CONTENT_LANGUAGES_COOKIE = 'rezics_content_languages';

/** Main keeps at most this many reading languages (`READING_LANGUAGE_LIMIT`). */
export const CONTENT_LANGUAGE_LIMIT = 20;

export function storedContentLanguages(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, CONTENT_LANGUAGE_LIMIT) : [];
  } catch { return []; }
}

/**
 * Signed-in readers use Main's list, including when it is empty.
 * The cookie is only the signed-out reader's list.
 */
export function readerContentLanguages(input: { signedIn: boolean; profile?: readonly string[] | null;
  cookie?: string | null }): string[] {
  if (input.signedIn) return (input.profile ?? []).filter((language): language is string => typeof language === 'string');
  return storedContentLanguages(input.cookie);
}

/** Headers for one Main call. A signed-in call never copies the content-language cookie into them. */
export function displayLanguageHeaders(input: { signedIn: boolean; profile?: readonly string[] | null;
  cookie?: string | null; pageUrl?: string | null; browser?: readonly string[] | string | null }):
  { 'accept-language'?: string; 'x-rezics-display-languages'?: string } {
  const languages = displayLanguages({ pageUrl: input.pageUrl, browser: input.browser,
    content: readerContentLanguages(input) });
  if (!languages.length) return {};
  const value = languages.join(',');
  return { 'accept-language': value, 'x-rezics-display-languages': value };
}

export function contentLanguageCookie(languages: readonly string[]): string {
  return encodeURIComponent(JSON.stringify(languages));
}

/** Explicit page language, saved content order, UI locale, then browser order. */
export function displayLanguages(input: { pageUrl?: string | null; content?: readonly string[];
  uiLocale?: string | null; browser?: readonly string[] | string | null }): string[] {
  let page: URL | null = null;
  try { page = input.pageUrl ? new URL(input.pageUrl, 'https://rezics.com') : null; } catch { /* no page */ }
  const browser = typeof input.browser === 'string'
    ? readerLanguages(null, input.browser) : input.browser ?? [];
  const values = [page?.searchParams.get('language'), ...input.content ?? [],
    input.uiLocale ?? (page ? pathLocale(page.pathname) : null), ...browser];
  return [...new Set(values.map(value => value && canonicalLanguage(value)).filter((value): value is string => !!value))]
    .slice(0, 20);
}
