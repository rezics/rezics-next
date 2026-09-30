import { canonicalLanguage, readerLanguages } from '@rezics/main/language';
import { pathLocale } from './locale.ts';

export const CONTENT_LANGUAGES_COOKIE = 'rezics_content_languages';

export function storedContentLanguages(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
  } catch { return []; }
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
