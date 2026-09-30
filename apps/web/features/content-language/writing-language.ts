import { direction, parseLanguage } from '@rezics/main/language';
import { languageTag } from '../onboarding/languages.ts';

// The language of what a person writes is theirs to state. The interface
// locale never stands in for it: with nothing known, the text is sent as
// "Language not specified" (`und`), which Main keeps as unknown rather than
// English (docs/contracts/content-languages.md#one-native-language-contract).

/** BCP 47's "undetermined": the writer has not said which language this is. */
export const UNSPECIFIED = 'und';

/**
 * The language a writing surface starts in: the item's own when editing,
 * otherwise the writer's first reading language, otherwise unspecified.
 * A language the writer chose always wins, so a late answer about their
 * reading languages cannot change a choice already made.
 */
export function writingLanguage(input: { chosen?: string | null; existing?: string | null;
  reading: readonly string[] }): string {
  return input.chosen ?? input.existing ?? input.reading[0] ?? UNSPECIFIED;
}

/** The languages worth offering first: what the writer reads, what this text is in now, and its original. */
export function suggestedLanguages(input: { reading: readonly string[]; current?: string | null;
  original?: string | null }): string[] {
  const listed = [input.current, input.original, ...input.reading]
    .flatMap(tag => tag && tag !== UNSPECIFIED ? [languageTag(tag) ?? tag] : []);
  return [...new Set([...listed, UNSPECIFIED])];
}

/** `lang` and `dir` for a text area or its rendering, from the language the writer chose. */
export function textAttributes(language: string, text = ''): { lang: string | undefined; dir: 'ltr' | 'rtl' } {
  const known = language !== UNSPECIFIED && parseLanguage(language) !== null;
  return { lang: known ? language : undefined, dir: direction(known ? language : UNSPECIFIED, text) };
}

/** Whether `language` is a tag Main accepts for written content. */
export function isWritingLanguage(language: string): boolean {
  return languageTag(language) === language;
}
