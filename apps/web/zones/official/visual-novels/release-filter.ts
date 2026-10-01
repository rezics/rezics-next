import type { ZoneReleaseFilterSpec } from '@rezics/zone-sdk';
import { strings } from './strings.ts';

/** Language tags readers look for, suggested to the filter; the registry admits any other tag from an address. */
const languages = ['en', 'ja', 'zh-Hans', 'zh-Hant', 'ko', 'es', 'de', 'fr', 'ru', 'pt-BR', 'it'] as const;
/** Platform names as the catalogue records them (the VNDB platforms most releases use), suggested to the filter. */
const platforms = ['Windows', 'Switch', 'Linux', 'macOS', 'Android', 'iOS', 'PS Vita', 'PlayStation 4', 'Web'] as const;

function languageName(tag: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * The release filter the Visual Novels Zone offers, in the reader's language. Fields are registry facets inside the
 * release group; the registry decides which values are valid (the completeness and status sets are closed there)
 * and the Zone brings its words, its suggested languages and platforms, and the statuses a reader may skip.
 */
export function releaseFilter(locale: string): ZoneReleaseFilterSpec {
  const t = strings(locale);
  return {
    label: t.filterLabel,
    fields: [
      { facet: 'releaseLanguage', label: t.language, any: t.anyLanguage,
        options: languages.map(tag => ({ value: tag, label: languageName(tag, locale) })) },
      { facet: 'releasePlatform', label: t.platform, any: t.anyPlatform,
        options: platforms.map(value => ({ value, label: value })) },
      { facet: 'releaseCompleteness', label: t.completeness, any: t.anyCompleteness, options: [
        { value: 'complete', label: t.complete }, { value: 'partial', label: t.partial },
        { value: 'trial', label: t.trial }, { value: 'unknown', label: t.unknown }] },
      // A withdrawn, cancelled or virtual release is never an answer to "can I play this".
      { facet: 'releaseStatus', label: t.origin, any: t.anyOrigin, unchosen: ['official', 'unofficial'], options: [
        { value: 'official', label: t.official }, { value: 'unofficial', label: t.unofficial }] },
    ],
    apply: t.apply, clear: t.clear, summary: t.summary,
    noMatch: { title: t.noMatchTitle, body: t.noMatchBody }, keepLooking: t.keepLooking,
    coverKind: 'game',
  };
}
