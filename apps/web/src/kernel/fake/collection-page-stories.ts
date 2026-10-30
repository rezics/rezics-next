import type { KernelRecording } from '../fake';
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
  | 'pending-create'
  | 'pending-save'
  | 'failed-save'
  | 'conflict-save';

let mode: CollectionStoryMode = 'many';
let finishPendingCreate: (() => void) | undefined;
const clone = <T>(value: T): T => structuredClone(value);
const members = clone(memberPage.members);
const baseCollection = clone(collection.collection);
let editedCollection = clone(baseCollection);
let editedMembers = clone(members);
let following = false;
const receipts = new Map<string, KernelRecording>();
let finishPendingSave: (() => void) | undefined;
const itemIds = members.map((member) => member.id);

export function setCollectionStoryMode(next: CollectionStoryMode): void {
  mode = next;
  editedCollection = clone(baseCollection);
  editedMembers = clone(members);
  if (next === 'empty') {
    editedMembers = [];
    editedCollection.memberCount = 0;
  }
  if (next === 'one-page') {
    editedMembers = editedMembers.slice(0, 1);
    editedCollection.memberCount = 1;
  }
  if (next === 'notes-duplicates') {
    editedMembers.splice(1, 0, {
      ...clone(members[0]!),
      id: '01a17a3b-6e78-73b5-9efd-f4cc070cc9e1',
      note: 'A second occurrence with its own note.',
    });
    editedCollection.memberCount = 5;
  }
  if (next === 'private' || next === 'unlisted' || next === 'public') editedCollection.visibility = next;
  following = false;
  receipts.clear();
}

export function completePendingCollectionCreate(): void {
  finishPendingCreate?.();
  finishPendingCreate = undefined;
}

export function completePendingCollectionSave(): void {
  finishPendingSave?.();
  finishPendingSave = undefined;
}

function collectionResponse() {
  const value = clone(editedCollection);
  value.curatorAccountId = 'story-viewer';
  if (mode === 'public-reader') {
    value.visibility = 'public';
    value.curatorAccountId = '01a17a3a-20f5-72aa-9f14-f4cc56678199';
  }
  return { status: 200, collection: value };
}

function listResponse(request: Request) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const members = editedMembers;
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
  return { status: 200, members, next: null };
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/collections',
    story: ({ request }) => {
      if (new URL(request.url).searchParams.has('curatorAccountId')) return undefined;
      if (mode === 'none') return { status: 200, collections: [], next: null };
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
    path: new RegExp(`^/v1/collections/${baseCollection.id}$`),
    story: ({ request }) =>
      mode === 'hidden' || (editedCollection.visibility === 'private' && !request.headers.has('authorization'))
        ? {
            status: 404,
            type: 'https://rezics.com/problems/not_found',
            code: 'not_found',
          }
        : collectionResponse(),
  },
  {
    method: 'GET',
    path: new RegExp(`^/v1/collections/${baseCollection.id}/members$`),
    story: ({ request }) =>
      mode === 'hidden' || (editedCollection.visibility === 'private' && !request.headers.has('authorization'))
        ? { status: 404, code: 'not_found' }
        : listResponse(request),
  },
  {
    method: 'GET',
    path: /^\/v1\/follows\/[^/]+$/,
    story: () => ({ status: 200, follow: { state: following ? 'following' : 'not_following' } }),
  },
  {
    method: 'PUT',
    path: /^\/v1\/follows\/[^/]+$/,
    story: () => {
      following = true;
      return { status: 204 };
    },
  },
  {
    method: 'DELETE',
    path: /^\/v1\/follows\/[^/]+$/,
    story: () => {
      following = false;
      return { status: 204 };
    },
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
    path: new RegExp(`^/v1/collections/${baseCollection.id}$`),
    story: ({ request }) => writeStory(request),
  },
  {
    method: 'POST',
    path: new RegExp(`^/v1/collections/${baseCollection.id}/members/[^/]+(?::move|/\\$move)$`),
    story: ({ request }) => writeStory(request),
  },
  {
    method: 'PATCH',
    path: new RegExp(`^/v1/collections/${baseCollection.id}/members/[^/]+$`),
    story: ({ request }) => writeStory(request),
  },
  {
    method: 'DELETE',
    path: new RegExp(`^/v1/collections/${baseCollection.id}/members/[^/]+$`),
    story: ({ request }) => writeStory(request),
  },
];

/** Stateful replay of the current operations only. No selected future endpoint is faked as delivered. */
async function writeStory(request: Request) {
  const observedCollection = editedCollection;
  if (!request.headers.has('authorization')) return { status: 403, code: 'forbidden' };
  if (mode === 'pending-save')
    await new Promise<void>((resolve) => {
      finishPendingSave = resolve;
    });
  if (observedCollection !== editedCollection) return { status: 503, code: 'unavailable' };
  if (mode === 'failed-save') return { status: 503, code: 'unavailable' };
  if (mode === 'conflict-save') return { status: 409, code: 'conflict' };
  const key = request.headers.get('idempotency-key');
  if (!key) return { status: 400, code: 'invalid_request' };
  const replay = receipts.get(key);
  if (replay) return clone(replay);
  const body = request.method === 'DELETE' ? {} : ((await request.json()) as Record<string, unknown>);
  const path = new URL(request.url).pathname;
  const match = /\/members\/([^/:]+)(?::move|\/\$move)?$/.exec(path);
  let response: KernelRecording;
  if (!match) {
    if (body.revision !== editedCollection.revision) return { status: 409, code: 'conflict' };
    if (typeof body.title !== 'string' || !body.title.trim()) return { status: 400, code: 'invalid_request' };
    editedCollection.title = body.title;
    editedCollection.description = typeof body.description === 'string' ? body.description : '';
    if (body.visibility === 'private' || body.visibility === 'unlisted' || body.visibility === 'public')
      editedCollection.visibility = body.visibility;
    editedCollection.revision += 1;
    response = collectionResponse();
  } else {
    const member = editedMembers.find((value) => value.id === match[1]);
    if (!member) return { status: 404, code: 'not_found' };
    if (request.method === 'DELETE') {
      editedMembers = editedMembers.filter((value) => value.id !== member.id);
      editedCollection.memberCount -= 1;
      response = { status: 204 };
    } else if (request.method === 'PATCH') {
      member.note = typeof body.note === 'string' ? body.note : null;
      response = { status: 200, member: clone(member) };
    } else {
      const rest = editedMembers.filter((value) => value.id !== member.id);
      const index = body.after === null ? 0 : rest.findIndex((value) => value.id === body.after) + 1;
      if (body.after !== null && index === 0) return { status: 404, code: 'not_found' };
      rest.splice(index, 0, member);
      editedMembers = rest;
      response = { status: 200, member: clone(member) };
    }
  }
  receipts.set(key, clone(response));
  return response;
}

export const collectionStoryMemberIds = itemIds;
