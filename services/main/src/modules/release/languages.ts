import { canonicalLanguage } from '../display-language/select.ts';

/** Content languages on a release or external edition, per RFC 5646 and MARC 041.
 * Empty means not recorded. `zxx` is no linguistic content and stands alone.
 * `und` is only for a slot that requires a tag. `mul` never replaces a list. */

export class InvalidContentLanguages extends Error {}

const MAX_TAGS = 8;
const TAG_LENGTH = 35;

export function recordedLanguageTag(value: string): string {
  if (value.length > TAG_LENGTH) throw new InvalidContentLanguages('Language tag is invalid');
  const canonical = canonicalLanguage(value);
  if (!canonical || canonical.length > TAG_LENGTH || canonical.toLowerCase() === 'mul') {
    throw new InvalidContentLanguages('Language tag is invalid');
  }
  return canonical;
}

/** A list of content languages. Empty means the release did not record one. */
export function contentLanguages(values: readonly string[]): string[] {
  const tags = values.map(recordedLanguageTag);
  if (tags.length > MAX_TAGS || new Set(tags).size !== tags.length) {
    throw new InvalidContentLanguages('Content languages must be a short list of distinct tags');
  }
  if (tags.includes('zxx') && tags.length !== 1) {
    throw new InvalidContentLanguages('zxx stands alone for no linguistic content');
  }
  if (tags.includes('und')) throw new InvalidContentLanguages('und is not a content-language list entry');
  return [...tags].sort();
}

/** Original language of a translation. A required tag may be `und`; it is never `mul`. */
export function originalLanguages(values: readonly string[], isTranslation: boolean): string[] {
  const tags = values.map(recordedLanguageTag);
  if (tags.length > 4 || new Set(tags).size !== tags.length) {
    throw new InvalidContentLanguages('Original languages must be a short list of distinct tags');
  }
  if (tags.includes('zxx')) throw new InvalidContentLanguages('A translation source is not zxx');
  if (isTranslation && tags.length === 0) {
    throw new InvalidContentLanguages('A translation names its original language');
  }
  if (!isTranslation && tags.length !== 0) {
    throw new InvalidContentLanguages('Original language belongs on a translation');
  }
  return [...tags].sort();
}

/** Printed title or track-list language. Absent means not recorded, so `und` is not used. */
export function textLanguage(value: string | null): string | null {
  if (value === null || value === '') return null;
  const tag = recordedLanguageTag(value);
  if (tag === 'und') throw new InvalidContentLanguages('An optional text language is omitted rather than und');
  return tag;
}

export function languageListLiteral(tags: readonly string[]): string | null {
  return tags.length ? tags.join(' ') : null;
}
