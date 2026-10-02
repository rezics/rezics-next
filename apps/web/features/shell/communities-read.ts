import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState } from '../auth/session.ts';
import { type FollowKind, settle, uuidOf } from '../feed/types.ts';
import { serviceOrigin } from '../api/origins.ts';
import { mainRelationships } from '../relationships/api.ts';
import { displayLanguageHeaders } from '../../i18n/display-languages.ts';
import { followedCommunity, pinnedCommunities, spaceCommunities } from './communities-relationships.ts';
import { type Community, type CommunityNavigation, type Managed, type Moderated, realmOf, realmSegment }
  from './communities.ts';

/**
 * Who is reading, once per request. A signed-in person whose session Agent
 * (kept by Main for this web session) is eligible reads as that Agent; anyone
 * else reads the public view, since Main takes a token only with `actingSubject`.
 */
export const shellReader = cache(async () => {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const state = token ? await sessionAgentState() : null;
  const actingSubject = state?.sessionAgent.eligible ? state.sessionAgent.actingSubject ?? undefined : undefined;
  const bearer = actingSubject ? token : undefined;
  return { signedIn: Boolean(token), actingSubject, main: mainApiWithToken(bearer), anonymous: mainApiWithToken(undefined),
    avatarQuery: actingSubject ? `?actingSubject=${encodeURIComponent(actingSubject)}` : '' };
});

const relationshipReader = cache(async () => {
  const reader = await shellReader();
  if (!reader.actingSubject) return null;
  const [jar, incoming, preferences] = await Promise.all([cookies(), headers(),
    settle(() => reader.main.v1.me['person-preferences'].get({ query: { actingSubject: reader.actingSubject! } }))]);
  return mainRelationships(reader.actingSubject, { origin: serviceOrigin('MAIN_ORIGIN'), headers: {
    authorization: `Bearer ${jar.get(ACCESS_COOKIE)!.value}`,
    ...displayLanguageHeaders({ signedIn: true, profile: preferences.ok ? preferences.data.contentLanguages : [],
      pageUrl: incoming.get('x-rezics-page-url'), browser: incoming.get('accept-language') }),
  } });
});

/**
 * One page of the reader's follows of a kind, with whether each has activity
 * the reader has not seen. `complete` is false when they follow more than a page.
 */
export const readFollowed = cache(async (kind: 'realm' | 'zone'):
  Promise<{ items: Community[]; complete: boolean } | null> => {
  const api = await relationshipReader();
  if (!api) return null;
  // Realm and Zone aliases now name one Space. Existing feed consumers still key membership by Realm.
  if (kind === 'zone') return { items: [], complete: true };
  try {
    const page = await api.follows({ kind: 'space', include: 'newSince' });
    return { items: page.items.map(followedCommunity).filter(item => item !== null)
      .map(item => ({ ...item, id: item.realm ?? item.id })), complete: page.complete };
  } catch { return null; }
});

/** Official Zones for everyone, named by their backing Realm; at most six, in Main's order. */
export const readOfficialZones = cache(async (_language: string): Promise<Community[]> => {
  const reader = await shellReader();
  const list = await settle(() => reader.anonymous.v1.zones.get({ query: { official: 'true', limit: 6 } }));
  if (!list.ok) return [];
  const named = await Promise.all(list.data.items.slice(0, 6).map(async zone => {
    const realm = await settle(() => reader.anonymous.v1.realms({ realm: uuidOf(zone.realm) }).get());
    return realm.ok ? { id: zone.zone, kind: 'zone' as const, realm: zone.realm, name: realm.data.name.value,
      language: realm.data.name.language, direction: realm.data.name.direction,
      icon: realm.data.icon, href: `/r/${zone.routeSegment}`,
      activity: 'unknown' as const } : null;
  }));
  return named.filter(item => item !== null);
});

/**
 * The Realms the reader manages, with their open queues, from Main's one
 * read of the reader's role assignments. Counts cover only what the reader
 * may decide; a refused or failed read shows no Manage entry.
 */
export const readManaged = cache(async (language: string): Promise<Managed[]> => {
  const reader = await shellReader();
  if (!reader.actingSubject) return [];
  const [page, official] = await Promise.all([settle(() => reader.main.v1.me['managed-realms'].get({ query: {
    actingSubject: reader.actingSubject! } })), readOfficialZones(language)]);
  if (!page.ok) return [];
  return page.data.items.map(item => ({ realm: item.realm, open: item.openCount.value,
    more: item.openCount.kind !== 'exact', href: `/manage/r/${realmSegment(item.realm, official)}` }));
});

/** Managed Realms with names: from the follows and official Zones already read, otherwise one Realm read each. */
export const readModerated = cache(async (language: string): Promise<Moderated[]> => {
  const reader = await shellReader();
  const [managed, realms, zones, official] = await Promise.all([readManaged(language), readFollowed('realm'),
    readFollowed('zone'), readOfficialZones(language)]);
  const known = [...realms?.items ?? [], ...zones?.items ?? [], ...official];
  return Promise.all(managed.slice(0, 8).map(async item => {
    const named = known.find(community => realmOf(community) === item.realm);
    if (named) return { ...item, name: named.name, language: named.language };
    const read = await settle(() => reader.anonymous.v1.realms({ realm: uuidOf(item.realm) }).get());
    return read.ok ? { ...item, name: read.data.name.value, language: read.data.name.language }
      : { ...item, name: uuidOf(item.realm).slice(0, 8) };
  }));
});

/** A followed Realm that is an official Zone's opens at the Zone's address, as the official list links it. */
function withZoneAddress(realms: Community[], official: readonly Community[]): Community[] {
  return realms.map(realm => {
    const zone = official.find(item => item.realm === realm.id);
    return zone ? { ...realm, href: zone.href } : realm;
  });
}

/** Everything the side navigation lists below its main items. */
export async function readCommunityNavigation(language: string): Promise<CommunityNavigation> {
  const reader = await shellReader();
  const api = await relationshipReader();
  const [pinned, spaces, inventory, official, moderated] = await Promise.all([
    api ? pinnedCommunities(api, '', null).catch(() => null) : null,
    api ? spaceCommunities(api, '', null).catch(() => null) : null,
    api ? api.follows().catch(() => null) : null, readOfficialZones(language), readManaged(language)]);
  return { signedIn: reader.signedIn, avatarQuery: reader.avatarQuery,
    followed: spaces ? { realms: withZoneAddress(spaces.items, official), zones: [] } : null,
    official, moderated, relationships: { actingSubject: reader.actingSubject ?? null,
      hasFollows: reader.signedIn ? inventory ? inventory.items.length > 0 || !inventory.complete : null : false,
      pinned, spaces } };
}
