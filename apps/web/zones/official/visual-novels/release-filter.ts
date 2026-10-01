import type { ZoneReleaseFilterSpec } from '@rezics/zone-sdk';
import { strings } from './strings.ts';

/** Language tags readers look for, written as Main's `releaseLanguage` values; others still work from the address. */
const languages = ['en', 'ja', 'zh-Hans', 'zh-Hant', 'ko', 'es', 'de', 'fr', 'ru', 'pt-BR', 'it'] as const;
/** Platform names as the catalogue records them (the VNDB platforms most releases use). */
const platforms = ['Windows', 'Switch', 'Linux', 'macOS', 'Android', 'iOS', 'PS Vita', 'PlayStation 4', 'Web'] as const;

function languageName(tag: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** The release filter the Visual Novels Zone offers, in the reader's language. */
export function releaseFilter(locale: string): ZoneReleaseFilterSpec {
  const t = strings(locale);
  return {
    label: t.filterLabel,
    language: { label: t.language, any: t.anyLanguage,
      options: languages.map(tag => ({ value: tag, label: languageName(tag, locale) })) },
    platform: { label: t.platform, any: t.anyPlatform,
      options: platforms.map(value => ({ value, label: value })) },
    completeness: { label: t.completeness, any: t.anyCompleteness, options: [
      { value: 'complete', label: t.complete }, { value: 'partial', label: t.partial },
      { value: 'trial', label: t.trial }, { value: 'unknown', label: t.unknown }] },
    origin: { label: t.origin, any: t.anyOrigin, options: [
      { value: 'official', label: t.official }, { value: 'unofficial', label: t.unofficial }] },
    apply: t.apply, clear: t.clear, summary: t.summary,
    noMatch: { title: t.noMatchTitle, body: t.noMatchBody }, keepLooking: t.keepLooking,
    coverKind: 'game',
  };
}
