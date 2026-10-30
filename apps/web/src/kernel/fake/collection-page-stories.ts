import type { KernelRecording } from '../fake';
import type { FakeRoute } from '../fake-modules.ts';
import collection from '../recorded/library-collection.json';
import memberPage from '../recorded/library-collection-members.json';
import collections from '../recorded/library-collections.json';
import subject from '../recorded/subject.json';
import type { CollectionPresentationData } from '../../library/collection-presentation';

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
  | 'conflict-save'
  | 'presentation'
  | 'expired-undo';

let mode: CollectionStoryMode = 'many';
let finishPendingCreate: (() => void) | undefined;
const clone = <T>(value: T): T => structuredClone(value);
const members = clone(memberPage.members);
const baseCollection = clone(collection.collection);
let editedCollection: typeof baseCollection & CollectionPresentationData & { coverMediaId?: string | null } =
  clone(baseCollection);
let editedMembers = clone(members);
const removed = new Map<
  string,
  { member: (typeof members)[number]; index: number; deletionId: string; revision: number; deadline: number }
>();
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
  if (next === 'presentation') {
    editedCollection.presentationKind = 'schema:Book';
    editedCollection.presentationKindSource = 'owner';
    editedCollection.coverMediaId = subject.summary.cover.media;
    editedCollection.cover = clone(subject.summary.cover);
    editedCollection.coverSource = 'owner';
  }
  removed.clear();
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

function collectionResponse(request?: Request) {
  const value = clone(editedCollection);
  value.curatorAccountId = 'story-viewer';
  if (mode === 'public-reader') {
    value.visibility = 'public';
    value.curatorAccountId = '01a17a3a-20f5-72aa-9f14-f4cc56678199';
    delete value.coverMediaId;
  }
  if (request && !request.headers.has('authorization')) delete value.coverMediaId;
  return {
    status: 200,
    collection: {
      ...value,
      presentationKind: value.presentationKind ?? null,
      presentationKindSource: value.presentationKind ? 'owner' : value.memberCount === 0 ? 'empty' : 'pending',
      coverSource: value.cover ? 'owner' : value.memberCount === 0 ? 'none' : 'pending',
    },
  };
}

function listResponse(request: Request) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const members = editedMembers.map((member) =>
    mode === 'presentation' && member.subject.id === subject.summary.id
      ? { ...member, subject: clone(subject.summary) }
      : member,
  );
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
        : collectionResponse(request),
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
  {
    method: 'POST',
    path: new RegExp(`^/v1/collections/${baseCollection.id}/members/[^/]+(?::restore|/\\$restore)$`),
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
  const match = /\/members\/([^/:]+)(?::(?:move|restore)|\/\$(?:move|restore))?$/.exec(path);
  let response: KernelRecording;
  if (!match) {
    if (body.revision !== editedCollection.revision) return { status: 409, code: 'conflict' };
    if (typeof body.title !== 'string' || !body.title.trim()) return { status: 400, code: 'invalid_request' };
    editedCollection.title = body.title;
    editedCollection.description = typeof body.description === 'string' ? body.description : '';
    if (body.visibility === 'private' || body.visibility === 'unlisted' || body.visibility === 'public')
      editedCollection.visibility = body.visibility;
    if (body.presentationKind === null || typeof body.presentationKind === 'string')
      editedCollection.presentationKind = body.presentationKind;
    if (body.coverMediaId === null || body.coverMediaId === subject.summary.cover.media) {
      editedCollection.coverMediaId = body.coverMediaId;
      if (body.coverMediaId) editedCollection.cover = clone(subject.summary.cover);
      else delete editedCollection.cover;
    }
    editedCollection.revision += 1;
    response = collectionResponse();
  } else if (path.endsWith(':restore') || path.endsWith('/$restore')) {
    const saved = removed.get(match[1]!);
    if (!saved || saved.deletionId !== body.deletionId) return { status: 404, code: 'not_found' };
    if (mode === 'expired-undo' || Date.now() >= saved.deadline) return { status: 409, code: 'member_restore_expired' };
    if (body.revision !== saved.revision) return { status: 409, code: 'member_restore_stale' };
    editedMembers.splice(Math.min(saved.index, editedMembers.length), 0, clone(saved.member));
    removed.delete(saved.member.id);
    editedCollection.memberCount += 1;
    editedCollection.revision += 1;
    response = { status: 200, member: clone(saved.member) };
  } else {
    const member = editedMembers.find((value) => value.id === match[1]);
    if (!member) return { status: 404, code: 'not_found' };
    if (request.method === 'DELETE') {
      if (Number(new URL(request.url).searchParams.get('revision')) !== editedCollection.revision)
        return { status: 409, code: 'conflict' };
      const deletionId = crypto.randomUUID();
      editedCollection.revision += 1;
      removed.set(member.id, {
        member: clone(member),
        index: editedMembers.indexOf(member),
        deletionId,
        revision: editedCollection.revision,
        deadline: Date.now() + 720 * 60 * 60 * 1000,
      });
      editedMembers = editedMembers.filter((value) => value.id !== member.id);
      editedCollection.memberCount -= 1;
      response = {
        status: 204,
        headers: {
          'Library-Collection-Member-Deletion-Id': deletionId,
          'Library-Collection-Member-Deletion-Revision': String(editedCollection.revision),
        },
      };
    } else if (request.method === 'PATCH') {
      member.note = typeof body.note === 'string' ? body.note : null;
      editedCollection.revision += 1;
      response = { status: 200, member: clone(member) };
    } else {
      const rest = editedMembers.filter((value) => value.id !== member.id);
      const index = body.after === null ? 0 : rest.findIndex((value) => value.id === body.after) + 1;
      if (body.after !== null && index === 0) return { status: 404, code: 'not_found' };
      rest.splice(index, 0, member);
      editedMembers = rest;
      editedCollection.revision += 1;
      response = { status: 200, member: clone(member) };
    }
  }
  receipts.set(key, clone(response));
  return response;
}

export const collectionStoryMemberIds = itemIds;
