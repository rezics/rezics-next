import { recordedLanguageTag } from '../release/languages.ts';
import type { AnyReleaseRecord } from '../release/schema.ts';

/** A preference retains the language of its exact release revision. Unknown
 * release-v1 coverage does not assert a language or a realization. */
export function preferenceReleaseMatches(record: AnyReleaseRecord, work: string, language: string | null): boolean {
  if (record.profile === 'release-v2') {
    return language !== null && record.resolvedCoverage.some(entry => entry.work === work
      && recordedLanguageTag(entry.language) === language);
  }
  return record.work === work && (language === null ? record.contentLanguages.length === 0
    : record.contentLanguages.some(tag => recordedLanguageTag(tag) === language));
}
