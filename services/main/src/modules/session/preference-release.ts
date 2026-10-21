import { recordedLanguageTag } from '../release/languages.ts';
import type { AnyReleaseRecord } from '../release/schema.ts';

/** A preference retains its exact release revision. Release-v1's public
 * coverage has no realization language, even when its bibliography records
 * content languages; null preserves that unknown correspondence. */
export function preferenceReleaseMatches(record: AnyReleaseRecord, work: string, language: string | null): boolean {
  if (record.profile === 'release-v2') {
    return language !== null && record.resolvedCoverage.some(entry => entry.work === work
      && recordedLanguageTag(entry.language) === language);
  }
  return record.work === work && (language === null
    || record.contentLanguages.some(tag => recordedLanguageTag(tag) === language));
}
