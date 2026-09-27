import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken } from '../api/main.ts';
import { idOf, parseRealmRef } from './route.ts';
import { type AgentRead, failureOf, type Loaded, type OfficialZone, type RankingMetric, type RankingPage,
  type RealmDecisionsPage, type RealmDecisionRead, type RealmDirectoryPage, type RealmHeader, type RealmRoster,
  type RealmZoneRead,
  type RealmWorksPage, type ZoneChapterPage, type ZoneDecisionPage, type ZoneEditorLists,
  type ZoneGenrePage, type ZonePresentationRead, type ZoneReplyPage, type ZoneWorkPage } from './types.ts';

// Server reads for Realm pages. Every read is public: Main answers Realm,
// Zone presentation and Zone module reads the same for everyone, so no
// bearer token is sent and nothing here varies by reader. Reads are cached per
// request, so the frame, the tabs and the modules share one Main call each.

const main = () => mainApiWithToken(undefined);

type Answer<T> = { data: T | null; error: { status: number } | null };

/**
 * One Main read as a `Loaded` result. Main answers 409 when the graph moved
 * during a first-page read; that read simply starts again, once. A moved
 * cursor is the reader's to restart.
 */
async function settle<T>(call: () => Promise<Answer<T>>, cursor?: string): Promise<Loaded<T>> {
  try {
    let { data, error } = await call();
    if (error?.status === 409 && !cursor) ({ data, error } = await call());
    if (error) return { ok: false, failure: failureOf(error.status) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

export type RealmResolution =
  | { kind: 'realm'; ref: string; realm: string; header: RealmHeader;
    zone: { id: string; segment: string | null } | null }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

const officialZone = cache(async (segment: string): Promise<Loaded<OfficialZone>> =>
  settle(() => main().v1.zones['by-segment']({ segment }).get()));

export const readRealmHeader = cache(async (realm: string, locale: UiLocale): Promise<Loaded<RealmHeader>> =>
  settle(() => main().v1.realms({ realm }).get({ query: { language: locale } })));

const readRealmZone = cache(async (realm: string): Promise<Loaded<RealmZoneRead>> =>
  settle(() => main().v1.realms({ realm }).zone.get({ query: {} })));

/**
 * The Realm behind `/r/{ref}`: a Realm UUID, or an official Zone's route
 * segment resolved to its Realm. Shared by every tab and its metadata.
 */
export const resolveRealm = cache(async (ref: string, locale: UiLocale): Promise<RealmResolution> => {
  const parsed = parseRealmRef(ref);
  if (!parsed) return { kind: 'missing' };
  let realm: string;
  let zone: { id: string; segment: string | null } | null = null;
  if (parsed.kind === 'segment') {
    const official = await officialZone(parsed.segment);
    if (!official.ok) return { kind: official.failure === 'missing' ? 'missing' : 'unavailable' };
    const realmId = idOf(official.data.realm);
    const zoneId = idOf(official.data.zone);
    if (!realmId || !zoneId) return { kind: 'unavailable' };
    realm = realmId;
    zone = { id: zoneId, segment: official.data.routeSegment };
  } else realm = parsed.id;
  const header = await readRealmHeader(realm, locale);
  if (!header.ok) return { kind: header.failure === 'missing' ? 'missing' : 'unavailable' };
  const selected = await readRealmZone(realm);
  if (selected.ok) {
    const zoneId = idOf(selected.data.zone);
    if (!zoneId || selected.data.realm !== header.data.id
      || zone && (zone.id !== zoneId || zone.segment !== selected.data.routeSegment)) {
      return { kind: 'unavailable' };
    }
    zone = { id: zoneId, segment: selected.data.routeSegment };
  } else if (selected.failure !== 'missing' && !zone) return { kind: 'unavailable' };
  return { kind: 'realm', ref, realm, header: header.data, zone };
});

export const readPresentation = cache(async (zone: string): Promise<Loaded<ZonePresentationRead>> =>
  settle(() => main().v1.zones({ id: zone }).presentation.get({ query: {} })));

export const readRealmWorks = cache(async (realm: string, locale: UiLocale, cursor?: string):
  Promise<Loaded<RealmWorksPage>> =>
  settle(() => main().v1.realms({ realm }).works.get({ query: { language: locale, cursor } }), cursor));

export const readRealmDecisions = cache(async (realm: string, cursor?: string): Promise<Loaded<RealmDecisionsPage>> =>
  settle(() => main().v1.realms({ realm }).decisions.get({ query: { cursor } }), cursor));

export const readRealmDecision = cache(async (realm: string, decision: string): Promise<Loaded<RealmDecisionRead>> =>
  settle(() => main().v1.realms({ realm }).decisions({ decision }).get({ query: {} })));

export const readNewAdoptions = cache(async (realm: string, locale: UiLocale): Promise<Loaded<ZoneWorkPage>> =>
  settle(() => main().v1.realms({ realm }).modules['new-adoptions'].get({ query: { language: locale } })));

export const readRecentlyCompleted = cache(async (realm: string, locale: UiLocale): Promise<Loaded<ZoneWorkPage>> =>
  settle(() => main().v1.realms({ realm }).modules['recently-completed'].get({ query: { language: locale } })));

export const readLatestChapters = cache(async (realm: string, locale: UiLocale): Promise<Loaded<ZoneChapterPage>> =>
  settle(() => main().v1.realms({ realm }).modules['latest-chapters'].get({ query: { language: locale } })));

/** One page of the Realm's chart for an interval: the most-read Works first. */
export const readRankings = cache(async (realm: string, locale: UiLocale, interval: 'day' | 'week' | 'month',
  metric: RankingMetric): Promise<Loaded<RankingPage>> =>
  settle(() => main().v1.realms({ realm }).rankings.get({ query: { metric, interval, language: locale, limit: 10 } })));

/** Works gaining readers fastest against the previous interval. */
export const readRising = cache(async (realm: string, locale: UiLocale): Promise<Loaded<RankingPage>> =>
  settle(() => main().v1.realms({ realm }).modules.rising.get({ query: { interval: 'week', language: locale,
    limit: 8 } })));

export const readRecentDecisions = cache(async (realm: string): Promise<Loaded<ZoneDecisionPage>> =>
  settle(() => main().v1.realms({ realm }).modules['recent-decisions'].get({ query: {} })));

export const readZoneQuotes = cache(async (realm: string, locale: UiLocale): Promise<Loaded<ZoneReplyPage>> =>
  settle(() => main().v1.realms({ realm }).modules['reader-quotes'].get({ query: { language: locale } })));

export const readZoneDiscussions = cache(async (realm: string, locale: UiLocale): Promise<Loaded<ZoneReplyPage>> =>
  settle(() => main().v1.realms({ realm }).modules.discussions.get({ query: { language: locale } })));

export const readZoneEditorLists = cache(async (realm: string, locale: UiLocale): Promise<Loaded<ZoneEditorLists>> =>
  settle(() => main().v1.realms({ realm }).modules['editor-lists'].get({ query: { language: locale } })));

export const readZoneGenres = cache(async (realm: string, context: string, locale: UiLocale):
  Promise<Loaded<ZoneGenrePage>> =>
  settle(() => main().v1.realms({ realm }).modules.genres({ context }).get({ query: { language: locale } })));

/** A few active public Realms, for "Other communities". */
export const readRealmDirectory = cache(async (locale: UiLocale): Promise<Loaded<RealmDirectoryPage>> =>
  settle(() => main().v1.realms.get({ query: { language: locale, limit: 6, sort: 'activity' } })));

/** The members who chose to be listed (G-314's public roster), featured first by the moderators' choice. */
export const readRoster = cache(async (realm: string): Promise<Loaded<RealmRoster>> =>
  settle(() => main().v1.realms({ realm }).roster.get({ query: { limit: 24 } })));

/** An Agent's public profile, for a moderator's name and profile link. */
export const readAgent = cache(async (agent: string): Promise<Loaded<AgentRead>> =>
  settle(() => main().v1.agents({ id: agent }).get({ query: {} })));
