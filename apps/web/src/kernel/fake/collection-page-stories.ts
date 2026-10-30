import type { FakeRoute } from '../fake-modules.ts';
import collection from '../recorded/library-collection.json';
import memberPage from '../recorded/library-collection-members.json';
import collections from '../recorded/library-collections.json';

export type CollectionStoryMode =
  | 'many'
  | 'none'
  | 'one'
  | 'private'
  | 'hidden'
  | 'unlisted'
  | 'public'
  | 'public-reader'
  | 'empty'
  | 'one-page'
  | 'many-pages'
  | 'notes-duplicates'
  | 'deep-page'
  | 'final-page'
  | 'preparing'
  | 'stale'
  | 'failed-create'
  | 'pending-create';

let mode: CollectionStoryMode = 'many';
let finishPendingCreate: (() => void) | undefined;
const clone = <T>(value: T): T => structuredClone(value);
const members = clone(memberPage.members);
const baseCollection = clone(collection.collection);
const itemIds = members.map((member) => member.id);

export function setCollectionStoryMode(next: CollectionStoryMode): void {
  mode = next;
}

export function completePendingCollectionCreate(): void {
  finishPendingCreate?.();
  finishPendingCreate = undefined;
}

function collectionResponse() {
  const value = clone(baseCollection);
  value.curatorAccountId = 'story-viewer';
  if (mode === 'notes-duplicates') value.memberCount = 5;
  if (mode === 'private' || mode === 'unlisted' || mode === 'public') value.visibility = mode;
  if (mode === 'public-reader') {
    value.visibility = 'public';
    value.curatorAccountId = '01a17a3a-20f5-72aa-9f14-f4cc56678199';
  }
  return { status: 200, collection: value };
}

function listResponse(request: Request) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  if (mode === 'unlisted' && !request.headers.has('authorization')) return { status: 200, members: [], next: null };
  if (mode === 'preparing')
    return {
      status: 503,
      type: 'https://rezics.com/problems/unavailable',
      code: 'unavailable',
    };
  if (mode === 'stale' && cursor)
    return {
      status: 409,
      type: 'https://rezics.com/problems/stale_cursor',
      code: 'stale_cursor',
    };
  if (mode === 'deep-page' && !cursor) return { status: 200, members: members.slice(0, 1), next: 'page-two' };
  if (mode === 'deep-page' && cursor === 'page-two')
    return { status: 200, members: members.slice(1, 3), next: 'page-three' };
  if (mode === 'final-page') return { status: 200, members: members.slice(-1), next: null };
  if (mode === 'empty') return { status: 200, members: [], next: null };
  if (mode === 'one-page') return { status: 200, members: members.slice(0, 1), next: null };
  if (mode === 'many-pages') return { status: 200, members, next: 'page-two' };
  if (mode === 'notes-duplicates') {
    const duplicate = {
      ...members[0]!,
      id: '01a17a3b-6e78-73b5-9efd-f4cc070cc9e1',
      note: 'A second occurrence with its own note.',
    };
    return {
      status: 200,
      members: [members[0]!, duplicate, ...members.slice(1)],
      next: null,
    };
  }
  return { status: 200, members, next: null };
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/collections',
    story: () => {
      if (mode === 'none') return { status: 200, collections: [] };
      if (mode === 'one')
        return {
          status: 200,
          collections: collections.collections.slice(0, 1),
          next: null,
        };
      return clone(collections);
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/collections\/[^/]+$/,
    story: () =>
      mode === 'hidden'
        ? {
            status: 404,
            type: 'https://rezics.com/problems/not_found',
            code: 'not_found',
          }
        : collectionResponse(),
  },
  {
    method: 'GET',
    path: /^\/v1\/collections\/[^/]+\/members$/,
    story: ({ request }) => listResponse(request),
  },
  {
    method: 'GET',
    path: /^\/v1\/follows\/[^/]+$/,
    story: () => ({ status: 200, follow: { state: 'not_following' } }),
  },
  {
    method: 'PUT',
    path: /^\/v1\/follows\/[^/]+$/,
    story: () => ({ status: 204 }),
  },
  {
    method: 'DELETE',
    path: /^\/v1\/follows\/[^/]+$/,
    story: () => ({ status: 204 }),
  },
  {
    method: 'POST',
    path: '/v1/collections',
    story: async () => {
      if (mode === 'pending-create')
        await new Promise<void>((resolve) => {
          finishPendingCreate = resolve;
        });
      return mode === 'failed-create'
        ? {
            status: 503,
            type: 'https://rezics.com/problems/unavailable',
            code: 'unavailable',
          }
        : { status: 201, collection: { id: baseCollection.id } };
    },
  },
  {
    method: 'PATCH',
    path: /^\/v1\/collections\/[^/]+$/,
    story: () => ({ status: 204 }),
  },
  {
    method: 'POST',
    path: /^\/v1\/collections\/[^/]+\/members\/[^/]+\/\$move$/,
    story: () => ({ status: 204 }),
  },
  {
    method: 'PATCH',
    path: /^\/v1\/collections\/[^/]+\/members\/[^/]+$/,
    story: () => ({ status: 204 }),
  },
];

export const collectionStoryMemberIds = itemIds;
