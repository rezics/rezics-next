import type { ZoneMatchedRelease, ZoneReleaseFilterSpec, ZoneReleaseMatches, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import { type AdaptContext, zoneImage, zoneText, workLink } from '../realm/adapt.ts';
import type { MainAvatar, MainName } from '../realm/types.ts';
import type { Names, Realization, Release } from '../work-levels/types.ts';
import { type ReleaseFilterState } from './state.ts';

/** One result of Main's release query: a Work and the IDs of the releases that satisfied the group. */
export interface ReleaseHit {
  id: string; title: MainName; cover: MainAvatar | null;
  matchedReleases: readonly string[]; moreMatchedReleases: boolean;
}

/** The records read for the matched releases: each release, and the realizations it carries. */
export interface ReleaseRecords {
  releases: ReadonlyMap<string, Release>;
  realizations: ReadonlyMap<string, Realization>;
  names: Names;
}

/** How many matched releases of one Work are read and shown; Main names up to eight. */
export const SHOWN_MATCHES = 2;

/**
 * The coverage entry of this Work that satisfied the filter: the same language and completeness the
 * reader chose, so a release that carries Japanese complete and English trial entries states the one
 * that matched and not the other. Without a chosen language, the Work's first entry.
 */
function matchedEntry(release: Release, work: string, state: ReleaseFilterState) {
  const own = release.coverage.filter(entry => entry.work === work);
  return own.find(entry => (!state.language || entry.language === state.language)
    && (!state.completeness || entry.completeness === state.completeness)) ?? own[0] ?? null;
}

/** What one matched release states, from the records of that release alone. */
export function matchedRelease(release: Release, work: string, state: ReleaseFilterState,
  records: ReleaseRecords): ZoneMatchedRelease {
  const entry = matchedEntry(release, work, state);
  const realization = entry?.realization ? records.realizations.get(entry.realization) : undefined;
  const translators = (realization?.translators ?? []).flatMap((agent): ZoneText[] => {
    const summary = records.names.get(agent);
    return summary?.status === 'available' ? [zoneText(summary.name)] : [];
  });
  return { id: release.id, language: entry?.language ?? release.contentLanguages[0] ?? null,
    platform: release.platform, completeness: entry?.completeness ?? 'unknown',
    origin: release.status === 'unofficial' ? 'unofficial' : 'official', translators };
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
