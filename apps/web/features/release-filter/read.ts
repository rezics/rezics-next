import type { ZoneReleaseFilterSpec, ZoneText } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import type { AdaptContext } from '../realm/adapt.ts';
import { reader, settle } from '../work-page/read.ts';
import type { Loaded } from '../work-page/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { readAgent } from '../realm/read.ts';
import { readRealization, readRelease } from '../work-levels/read.ts';
import type { Realization, Release } from '../work-levels/types.ts';
import { type ReleaseHit, type ReleaseResult, releaseWork, SHOWN_MATCHES } from './adapt.ts';
import { type ReleaseFilterState, releaseGroup } from './state.ts';

// The release-filtered browse read: Main's one `where` group over releases (`POST /v1/query`, the
// release-works template), then the records of the releases Main named, so a card can say which one
// matched. Nothing here compares releases; a Work is a result only because Main returned it.

/** Main's page size for release results (its declared bound). */
export const RELEASE_PAGE = 20;

export interface ReleaseBrowsePage { items: ReleaseResult[]; next: string | null }

async function readHits(realm: string, locale: UiLocale, state: ReleaseFilterState):
  Promise<Loaded<{ hits: ReleaseHit[]; next: string | null }>> {
  const group = releaseGroup(state);
  if (!group) return { ok: false, failure: 'invalid' };
  const { main } = await reader();
  const query = { context: { realm }, scope: { kind: 'realm' as const, realm }, filter: { all: [group] },
    sort: 'newest' as const, page: { size: RELEASE_PAGE, ...state.cursor ? { continuation: state.cursor } : {} } };
  const answer = await settle(() => main.v1.query.post(query, { headers: { 'accept-language': locale } }),
    state.cursor ?? undefined);
  if (!answer.ok) return answer;
  const result = answer.data.result;
  if (result.profile !== 'release-works-v1') return { ok: false, failure: 'invalid' };
  return { ok: true, data: { hits: result.items, next: result.nextCursor } };
}

const uuid = (iri: string) => iri.slice(-36);

/** The records of the releases a page shows: at most `SHOWN_MATCHES` per Work, and the realizations they carry. */
async function readRecords(hits: readonly ReleaseHit[]) {
  const wanted = hits.flatMap(hit => hit.matchedReleases.slice(0, SHOWN_MATCHES).map(release => ({ work: hit.id, release })));
  const loaded = await Promise.all(wanted.map(async item => [item, await readRelease(uuid(item.work), uuid(item.release))] as const));
  const releases = new Map<string, Release>();
  const realizationIds = new Map<string, string>();
  for (const [item, read] of loaded) {
    if (!read.ok) continue;
    releases.set(item.release, read.data);
    for (const entry of read.data.coverage) {
      if (entry.work === item.work && entry.realization) realizationIds.set(entry.realization, item.work);
    }
  }
  const realizations = new Map<string, Realization>();
  await Promise.all([...realizationIds].map(async ([realization, work]) => {
    const read = await readRealization(uuid(work), uuid(realization));
    if (read.ok) realizations.set(realization, read.data);
  }));
  // A translator is an Agent; its public profile names it, and a profile Main will not give leaves it unnamed.
  const translators = new Map<string, ZoneText>();
  await Promise.all([...new Set([...realizations.values()].flatMap(item => item.translators))].map(async agent => {
    const read = await readAgent(uuid(agent));
    if (read.ok) translators.set(agent, read.data.displayNameInfo
      ? { value: read.data.displayNameInfo.value, lang: read.data.displayNameInfo.language,
        dir: read.data.displayNameInfo.direction } : zoneContentText(read.data.displayName));
  }));
  return { releases, realizations, translators };
}

/** One page of a Zone's release-filtered browse; a failed record read only drops that release's line. */
export async function readReleaseBrowse(realm: string, locale: UiLocale, state: ReleaseFilterState,
  context: AdaptContext, spec: Pick<ZoneReleaseFilterSpec, 'coverKind'>): Promise<Loaded<ReleaseBrowsePage>> {
  const page = await readHits(realm, locale, state);
  if (!page.ok) return page;
  const records = await readRecords(page.data.hits);
  return { ok: true, data: { next: page.data.next,
    items: page.data.hits.map(hit => releaseWork(hit, state, spec, context, records)) } };
}
