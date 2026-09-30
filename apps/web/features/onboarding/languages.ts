import { CONTENT_LANGUAGE_LIMIT } from '../../i18n/display-languages.ts';

// Content languages a reader keeps in their person settings: any BCP 47 tag,
// in the order they prefer them, since names show in the reader's languages
// one at a time (docs/plan/frontend.md). Pure helpers shared by the setup,
// its stories and tests.

/** Person settings keep Main's reading-language bound, not the count of interface locales. */
export const MAX_LANGUAGES = CONTENT_LANGUAGE_LIMIT;

/**
 * Languages offered to add beyond Main's suggestions, as tags `Intl` names.
 * A reader can also type any other well-formed tag.
 */
export const commonLanguages = ['en', 'zh-Hans', 'zh-Hant', 'yue', 'ja', 'ko', 'es', 'pt', 'pt-BR', 'fr', 'de', 'it',
  'nl', 'ru', 'uk', 'pl', 'cs', 'sv', 'nb', 'da', 'fi', 'tr', 'el', 'hu', 'ro', 'ar', 'he', 'fa', 'hi', 'bn', 'ur',
  'ta', 'te', 'th', 'vi', 'id', 'ms', 'fil', 'sw'] as const;

const shape = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

/** A typed tag in its canonical form (`zh-hans` → `zh-Hans`), or null when it is not a language tag Main keeps. */
export function languageTag(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const [canonical] = Intl.getCanonicalLocales(trimmed);
    return canonical && shape.test(canonical) ? canonical : null;
  } catch { return null; }
}

/** The list after adding a language at the end; a repeat or one past the bound changes nothing. */
export function added(languages: readonly string[], language: string): string[] {
  return languages.includes(language) || languages.length >= MAX_LANGUAGES ? [...languages] : [...languages, language];
}

/** The list with one language moved one place earlier. */
export function earlier(languages: readonly string[], language: string): string[] {
  const index = languages.indexOf(language);
  if (index <= 0) return [...languages];
  const next = [...languages];
  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
  return next;
}

/**
 * Languages matching what the reader typed, by tag or by name in their own
 * language or the language's own name, then the typed tag itself when it is
 * well formed and not listed.
 */
export function matchingLanguages(query: string, locale: string, exclude: readonly string[], limit = 6): string[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const names = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' });
  const found = commonLanguages.filter(tag => !exclude.includes(tag) && [tag, names.of(tag),
    new Intl.DisplayNames([tag], { type: 'language', fallback: 'none' }).of(tag)]
    .some(name => name?.toLowerCase().includes(text)));
  const typed = languageTag(query);
  return [...found, ...typed && !exclude.includes(typed) && !found.includes(typed as never) ? [typed] : []].slice(0, limit);
}
