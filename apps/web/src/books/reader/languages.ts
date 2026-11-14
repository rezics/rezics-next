import { canonicalLanguageKey, parseLanguagePreferences, MAX_LANGUAGE_PREFERENCES } from '@rezics/definitions/language';
import type { BookChapterAddress, BookSelection } from './source';

export const BOOK_LANGUAGE_PAGE_LIMIT = 20;
export type BookLanguagePreference = Readonly<{
  language: string | null;
  preferredLanguages: readonly string[];
}>;
export type BookLanguageChoice = Readonly<{
  language: string;
  title: string;
  selection: BookSelection;
}>;
export type BookLanguagePage = Readonly<{
  choices: readonly BookLanguageChoice[];
  nextCursor: string | null;
}>;
export type BookLanguageResult<Value> =
  | Readonly<{ state: 'ready'; value: Value }>
  | Readonly<{ state: 'denied' | 'not-found' | 'unavailable' | 'changed' }>;

/** One page of currently disclosed metadata, or one native choice; neither operation fetches body bytes. */
export type BookLanguageSource = Readonly<{
  list(
    address: BookChapterAddress,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<BookLanguageResult<BookLanguagePage>>;
  select(
    address: BookChapterAddress,
    preference: BookLanguagePreference,
    signal: AbortSignal,
  ): Promise<
    BookLanguageResult<{
      address: BookChapterAddress;
      language: string | null;
      title: string;
    }>
  >;
}>;

/** Exact language keys only; no prefix matching or interface-locale inference. */
export function bookPreferredLanguages(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values.slice(0, MAX_LANGUAGE_PREFERENCES)) {
    const language = canonicalLanguageKey(value);
    if (language && !result.includes(language)) result.push(language);
  }
  return result;
}

export function bookLanguagePreferenceWithinBounds(value: BookLanguagePreference | undefined): boolean {
  return (
    value === undefined ||
    ((value.language === null || canonicalLanguageKey(value.language) === value.language) &&
      parseLanguagePreferences(value.preferredLanguages) !== null)
  );
}

export function sameBookLanguagePreference(
  left: BookLanguagePreference | undefined,
  right: BookLanguagePreference | undefined,
) {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.language === right.language &&
      left.preferredLanguages.length === right.preferredLanguages.length &&
      left.preferredLanguages.every((language, index) => language === right.preferredLanguages[index]))
  );
}

export function nativeBookPreference(preference: BookLanguagePreference | undefined) {
  return preference
    ? {
        ...(preference.language ? { language: preference.language } : {}),
        ...(preference.preferredLanguages.length
          ? { preferredLanguages: preference.preferredLanguages.join(',') }
          : {}),
      }
    : {};
}

/** A complete tuple always suppresses preference fallback, including the canonical unknown-language default. */
export function nativeBookSelection(selection: BookSelection) {
  return {
    ...(selection.bodyLanguage ? { language: selection.bodyLanguage } : {}),
    targetPostId: selection.body.postId,
    targetRevisionId: selection.body.revisionId,
    targetSha256: selection.body.sha256,
  };
}
