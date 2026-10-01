import type { ZoneMatchedRelease, ZoneReleaseFilterSpec, ZoneReleaseMatches, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import { type AdaptContext, zoneImage, zoneText, workLink } from '../realm/adapt.ts';
import type { MainAvatar, MainName } from '../realm/types.ts';
import type { Realization, Release } from '../work-levels/types.ts';
import { type ReleaseFilterState } from './state.ts';

/** One result of Main's release query: a Work and the IDs of the releases that satisfied the group. */
export interface ReleaseHit {
  id: string; title: MainName; cover: MainAvatar | null;
  matchedReleases: readonly string[]; moreMatchedReleases: boolean;
}

/** The records read for the matched releases: each release, the realizations it carries and the names of their translators. */
export interface ReleaseRecords {
  releases: ReadonlyMap<string, Release>;
  realizations: ReadonlyMap<string, Realization>;
  /** Translator Agents by IRI, named by their public profile; one Agent Main will not name is simply absent. */
  translators: ReadonlyMap<string, ZoneText>;
}

/** How many matched releases of one Work are read and shown; Main names up to eight. */
export const SHOWN_MATCHES = 2;

/** The registry facets a release record's fields answer; a card states each as the reader's filter chose it. */
const facet = { language: 'releaseLanguage', platform: 'releasePlatform', completeness: 'releaseCompleteness',
  status: 'releaseStatus' } as const;
const completenessOf = (value: string | undefined): ZoneMatchedRelease['completeness'] | null =>
  value === 'complete' || value === 'partial' || value === 'trial' || value === 'unknown' ? value : null;

/**
 * The coverage entry of this Work the reader's language points at, preferring the entry that also has the chosen
 * completeness. Main compares a v2 record at release level and a v1 record by its content languages, so no entry
 * need carry both conditions; with a language chosen and no entry in it, there is no entry to describe.
 */
function matchedEntry(release: Release, work: string, state: ReleaseFilterState) {
  const own = release.coverage.filter(entry => entry.work === work);
  const language = state.conditions[facet.language];
  const completeness = state.conditions[facet.completeness];
  const inLanguage = language ? own.filter(entry => entry.language === language) : own;
  return inLanguage.find(entry => !completeness || entry.completeness === completeness) ?? inLanguage[0]
    ?? (language ? null : own[0] ?? null);
}

/**
 * What one matched release states. Every condition the reader chose is stated as chosen, because Main guarantees
 * the release meets it; the rest comes from the release and the entry for the chosen language, so a card never
 * shows another entry's language or completeness for a match.
 */
export function matchedRelease(release: Release, work: string, state: ReleaseFilterState,
  records: ReleaseRecords): ZoneMatchedRelease {
  const chosen = state.conditions;
  const entry = matchedEntry(release, work, state);
  const realization = entry?.realization ? records.realizations.get(entry.realization) : undefined;
  const translators = (realization?.translators ?? []).flatMap((agent): ZoneText[] => {
    const name = records.translators.get(agent);
    return name ? [name] : [];
  });
  const status = chosen[facet.status] ?? release.status;
  return { id: release.id,
    language: chosen[facet.language] ?? entry?.language ?? release.contentLanguages[0] ?? null,
    platform: chosen[facet.platform] ?? release.platform,
    completeness: completenessOf(chosen[facet.completeness]) ?? entry?.completeness ?? 'unknown',
    origin: status === 'unofficial' ? 'unofficial' : 'official', translators };
}

/** A release-filtered result: the Work as every Zone card draws it, and the releases Main matched for it. */
export interface ReleaseResult { work: ZoneWork; matches: ZoneReleaseMatches }

/**
 * A result as a Zone card. `matches` holds only releases whose ID Main returned for this Work: a record
 * read for any other release never reaches a card, so a card never says more than Main matched.
 */
export function releaseWork(hit: ReleaseHit, state: ReleaseFilterState, spec: Pick<ZoneReleaseFilterSpec, 'coverKind'>,
  context: AdaptContext, records: ReleaseRecords): ReleaseResult {
  const releases = hit.matchedReleases.slice(0, SHOWN_MATCHES).flatMap(id => {
    const release = records.releases.get(id);
    return release ? [matchedRelease(release, hit.id, state, records)] : [];
  });
  return { work: { id: hit.id, href: workLink(context, hit.id), title: zoneText(hit.title),
    cover: zoneImage(hit.cover, context.avatarQuery), kind: spec.coverKind, author: null, tagline: null,
    status: null, chapters: null, words: null, updatedAt: null, decision: null },
  matches: { releases, more: hit.moreMatchedReleases || hit.matchedReleases.length > releases.length } };
}
