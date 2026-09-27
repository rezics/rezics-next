import { cookies } from 'next/headers';
import { cache } from 'react';
import { mainApiWithToken } from '../api/main.ts';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState } from '../auth/session.ts';
import { type FollowEntry, type FollowKind, settle, uuidOf } from '../feed/types.ts';
import type { Community, CommunityNavigation, Moderated } from './communities.ts';

type ModerationProbe = Omit<Moderated, 'name'>;

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
  return { id: item.id, kind: item.kind === 'zone' ? 'zone' : 'realm', name: item.name.value,
    language: item.name.language, icon: item.icon, href: item.href, activity,
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
export const readOfficialZones = cache(async (language: string): Promise<Community[]> => {
  const reader = await shellReader();
  const list = await settle(() => reader.anonymous.v1.zones.get({ query: { official: 'true', limit: 6 } }));
  if (!list.ok) return [];
  const named = await Promise.all(list.data.items.slice(0, 6).map(async zone => {
    const realm = await settle(() => reader.anonymous.v1.realms({ realm: uuidOf(zone.realm) }).get({ query: { language } }));
    return realm.ok ? { id: zone.zone, kind: 'zone' as const, name: realm.data.name.value,
      language: realm.data.name.language, icon: realm.data.icon, href: `/r/${zone.routeSegment}`,
      activity: 'unknown' as const } : null;
  }));
  return named.filter(item => item !== null);
});

/**
 * The Realms among `realms` whose moderation queue the reader can open, with
 * its open items. Main has no "Realms I moderate" read yet, so this asks each
 * followed Realm's queue (a bounded handful, in parallel); a refusal means the
 * reader does not moderate it.
 */
export const readModerated = cache(async (realms: string): Promise<ModerationProbe[]> => {
  const reader = await shellReader();
  if (!reader.actingSubject || !realms) return [];
  const results = await Promise.all(realms.split(',').slice(0, 8).map(async realm => {
    const queue = await settle(() => reader.main.v1.realms({ realm: uuidOf(realm) }).moderation.get({ query: {
      actingSubject: reader.actingSubject!, state: 'open', limit: 20 } }));
    return queue.ok ? { realm, open: queue.data.items.length, more: queue.data.nextCursor !== null } : null;
  }));
  return results.filter(item => item !== null);
});

/** Everything the side navigation lists below its main items. */
export async function readCommunityNavigation(language: string): Promise<CommunityNavigation> {
  const reader = await shellReader();
  const [realms, zones, official] = await Promise.all([readFollowed('realm'), readFollowed('zone'),
    readOfficialZones(language)]);
  const moderated = realms ? await readModerated(realms.items.map(item => item.id).join(',')) : [];
  return { signedIn: reader.signedIn, avatarQuery: reader.avatarQuery,
    followed: realms && zones ? { realms: realms.items, zones: zones.items } : null,
    official, moderated: moderated.map(item => ({ ...item,
      name: realms?.items.find(realm => realm.id === item.realm)?.name ?? '' })) };
}
