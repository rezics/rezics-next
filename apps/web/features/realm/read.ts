import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken } from '../api/main.ts';
import { idOf, parseRealmRef } from './route.ts';
import { failureOf, type Loaded, type OfficialZone, type RealmDecisionsPage, type RealmDirectoryPage, type RealmHeader,
  type RealmWorksPage, type ZoneChapterPage, type ZoneDecisionPage, type ZonePresentationRead,
  type ZoneWorkPage } from './types.ts';

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
    /** The Realm's Zone when it is an official one; community Realms have no Zone read yet. */
    zone: { id: string; segment: string } | null }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

const officialZone = cache(async (segment: string): Promise<Loaded<OfficialZone>> =>
  settle(() => main().v1.zones['by-segment']({ segment }).get()));

export const readRealmHeader = cache(async (realm: string, locale: UiLocale): Promise<Loaded<RealmHeader>> =>
  settle(() => main().v1.realms({ realm }).get({ query: { language: locale } })));

/**
 * The Realm behind `/r/{ref}`: a Realm UUID, or an official Zone's route
 * segment resolved to its Realm. Shared by every tab and its metadata.
 */
export const resolveRealm = cache(async (ref: string, locale: UiLocale): Promise<RealmResolution> => {
  const parsed = parseRealmRef(ref);
  if (!parsed) return { kind: 'missing' };
  let realm: string;
  let zone: { id: string; segment: string } | null = null;
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
  return { kind: 'realm', ref, realm, header: header.data, zone };
});

export const readPresentation = cache(async (zone: string): Promise<Loaded<ZonePresentationRead>> =>
  settle(() => main().v1.zones({ id: zone }).presentation.get({ query: {} })));

export const readRealmWorks = cache(async (realm: string, locale: UiLocale, cursor?: string):
  Promise<Loaded<RealmWorksPage>> =>
  settle(() => main().v1.realms({ realm }).works.get({ query: { language: locale, cursor } }), cursor));

export const readRealmDecisions = cache(async (realm: string, cursor?: string): Promise<Loaded<RealmDecisionsPage>> =>
  settle(() => main().v1.realms({ realm }).decisions.get({ query: { cursor } }), cursor));

export const readNewAdoptions = cache(async (realm: string, locale: UiLocale): Promise<Loaded<ZoneWorkPage>> =>
  settle(() => main().v1.realms({ realm }).modules['new-adoptions'].get({ query: { language: locale } })));

export const readRecentlyCompleted = cache(async (realm: string, locale: UiLocale): Promise<Loaded<ZoneWorkPage>> =>
  settle(() => main().v1.realms({ realm }).modules['recently-completed'].get({ query: { language: locale } })));

export const readLatestChapters = cache(async (realm: string, locale: UiLocale): Promise<Loaded<ZoneChapterPage>> =>
  settle(() => main().v1.realms({ realm }).modules['latest-chapters'].get({ query: { language: locale } })));

export const readRecentDecisions = cache(async (realm: string): Promise<Loaded<ZoneDecisionPage>> =>
  settle(() => main().v1.realms({ realm }).modules['recent-decisions'].get({ query: {} })));

/** A few active public Realms, for "Other communities". */
export const readRealmDirectory = cache(async (locale: UiLocale): Promise<Loaded<RealmDirectoryPage>> =>
  settle(() => main().v1.realms.get({ query: { language: locale, limit: 6, sort: 'activity' } })));
