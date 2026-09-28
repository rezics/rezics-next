import { cookies } from 'next/headers';
import { cache } from 'react';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState } from '../auth/session.ts';
import { type FollowEntry, type FollowKind, settle, uuidOf } from '../feed/types.ts';
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

type Followed = Extract<FollowEntry, { available: true }>;

function community(item: Followed): Community {
  const activity = item.newSince?.state === 'new' || item.newSince?.state === 'more-unverified' ? 'new'
    : item.newSince ? 'none' : 'unknown';
  return { id: item.id, kind: item.kind === 'zone' ? 'zone' : 'realm', ...item.realm ? { realm: item.realm } : {},
    name: item.name.value, language: item.name.language, direction: item.name.direction,
    icon: item.icon, href: item.href, activity,
    ...(item.newSince?.count ? { count: item.newSince.count } : {}) };
}

/**
 * One page of the reader's follows of a kind, with whether each has activity
 * the reader has not seen. `complete` is false when they follow more than a page.
 */
export const readFollowed = cache(async (kind: Extract<FollowKind, 'realm' | 'zone'>):
  Promise<{ items: Community[]; complete: boolean } | null> => {
  const reader = await shellReader();
  if (!reader.actingSubject) return null;
  const page = await settle(() => reader.main.v1.me.follows.get({ query: { actingSubject: reader.actingSubject!, kind,
    include: 'newSince' } }));
  if (!page.ok) return null;
  return { items: page.data.items.filter((item): item is Followed => item.available).map(community),
    complete: page.data.nextCursor === null };
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
  const [realms, zones, official, moderated] = await Promise.all([readFollowed('realm'), readFollowed('zone'),
    readOfficialZones(language), readManaged(language)]);
  return { signedIn: reader.signedIn, avatarQuery: reader.avatarQuery,
    followed: realms && zones ? { realms: withZoneAddress(realms.items, official), zones: zones.items } : null,
    official, moderated };
}
