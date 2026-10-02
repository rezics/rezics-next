import type { EntityPickerPage } from '@rezics/ui/entity-picker';
import type { Follow, Membership, RelationshipsApi } from '../relationships/types.ts';
import type { Community } from './communities.ts';

export function followedCommunity(item: Follow): Community | null {
  if (!item.available || !item.name || !item.href) return null;
  return { id: item.id, kind: item.kind === 'space' ? 'realm' : 'resource', person: item.kind === 'agent', realm: item.realm ?? undefined,
    name: item.name.value, language: item.name.language, direction: item.name.direction, icon: item.icon,
    href: item.href, activity: item.newSince?.state === 'new' || item.newSince?.state === 'more-unverified' ? 'new'
      : item.newSince?.state === 'none' ? 'none' : 'unknown',
    ...(item.newSince?.count ? { count: item.newSince.count } : {}) };
}
const joinedCommunity = (item: Membership): Community | null => !item.available || !item.name ? null
  : { id: item.space ?? item.realm, realm: item.realm, kind: 'realm', name: item.name.value, language: item.name.language,
    direction: item.name.direction, icon: null, href: `/r/${item.realm.slice(-36)}`, activity: 'unknown' };

/** Pinned order is server-owned. Once the sorted page reaches an unpinned row, the pin traversal is complete. */
export async function pinnedCommunities(api: RelationshipsApi, q: string, cursor: string | null): Promise<EntityPickerPage<Community>> {
  const page = await api.follows({ q, cursor, order: 'pinned', include: 'newSince' });
  const complete = page.complete || page.items.some(item => item.pinPosition === null);
  return { items: page.items.filter(item => item.pinPosition !== null).map(followedCommunity).filter(item => item !== null),
    nextCursor: complete ? null : page.nextCursor, complete };
}

/** The two server traversals retain their own cursor and completeness; an exhausted stream is never restarted. */
export async function spaceCommunities(api: RelationshipsApi, q: string, cursor: string | null): Promise<EntityPickerPage<Community>> {
  const seek = cursor ? JSON.parse(cursor) as { follows: string | null; memberships: string | null } : null;
  const empty = { items: [], nextCursor: null, complete: true };
  const [follows, memberships] = await Promise.all([
    seek && seek.follows === null ? empty : api.follows({ q, cursor: seek?.follows, kind: 'space', order: 'recent', include: 'newSince' }),
    seek && seek.memberships === null ? empty : api.memberships({ q, cursor: seek?.memberships, order: 'recent' }),
  ]);
  if (!follows.complete && !follows.nextCursor || !memberships.complete && !memberships.nextCursor)
    throw new Error('Incomplete relationship page without continuation');
  const items = new Map<string, Community>();
  for (const item of follows.items.map(followedCommunity).concat(memberships.items.map(joinedCommunity)))
    if (item && !items.has(item.realm ?? item.id)) items.set(item.realm ?? item.id, item);
  const complete = follows.complete && memberships.complete;
  return { items: [...items.values()], complete, nextCursor: complete ? null
    : JSON.stringify({ follows: follows.complete ? null : follows.nextCursor, memberships: memberships.complete ? null : memberships.nextCursor }) };
}
