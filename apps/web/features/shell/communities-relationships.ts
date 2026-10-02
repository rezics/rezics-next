import type { EntityPickerPage } from '@rezics/ui/entity-picker';
import type { Follow, RelationshipsApi } from '../relationships/types.ts';
import type { Community } from './communities.ts';

export function followedCommunity(item: Follow): Community | null {
  if (!item.available || !item.name || !item.href) return null;
  return { id: item.id, kind: item.kind === 'space' ? 'realm' : 'resource', person: item.kind === 'agent', realm: item.realm ?? undefined,
    name: item.name.value, language: item.name.language, direction: item.name.direction, icon: item.icon,
    href: item.href, activity: item.newSince?.state === 'new' || item.newSince?.state === 'more-unverified' ? 'new'
      : item.newSince?.state === 'none' ? 'none' : 'unknown',
    ...(item.newSince?.count ? { count: item.newSince.count } : {}) };
}

/** Pinned order is server-owned. Once the sorted page reaches an unpinned row, the pin traversal is complete. */
export async function pinnedCommunities(api: RelationshipsApi, q: string, cursor: string | null): Promise<EntityPickerPage<Community>> {
  const page = await api.follows({ q, cursor, order: 'pinned', include: 'newSince' });
  const complete = page.complete || page.items.some(item => item.pinPosition === null);
  return { items: page.items.filter(item => item.pinPosition !== null).map(followedCommunity).filter(item => item !== null),
    nextCursor: complete ? null : page.nextCursor, complete };
}

/** Join writes its Space follow in Main. One server traversal owns activity ordering and continuation. */
export async function spaceCommunities(api: RelationshipsApi, q: string, cursor: string | null): Promise<EntityPickerPage<Community>> {
  const page = await api.follows({ q, cursor, kind: 'space', order: 'recent', include: 'newSince' });
  if (!page.complete && !page.nextCursor)
    throw new Error('Incomplete relationship page without continuation');
  return { ...page, items: page.items.map(followedCommunity).filter(item => item !== null) };
}
