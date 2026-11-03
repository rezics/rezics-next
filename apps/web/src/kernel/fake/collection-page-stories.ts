import { documentText, fromPlainText } from '@rezics/document';
import type { KernelRecording } from '../fake';
import type { FakeRoute } from '../fake-modules.ts';
import collection from '../recorded/library-collection.json';
import { collectionStoryMembers } from './collection-stories';
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
  | 'long-notes-sparse'
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
  | 'boundary-later'
  | 'boundary-pending'
  | 'boundary-unknown'
  | 'boundary-refresh-failed'
  | 'expired-undo';

/** Contract-shaped member notes derived from structural documents; native notes remain strings. */
export const collectionLongNotesSparse = {
  identity:
    '雪国 Snow Country — 川端康成 Yasunari Kawabata, a long attached identity that stays with this occurrence',
  notes: [
    documentText(
      fromPlainText(
        [
          '雪国の長い読書メモ — Kawabata kept this occurrence on the shelf after the winter train.',
          'The rooms stay quiet, and this note is the structural document for the first occurrence only.',
          'この出現は主題と別の識別子を持ち、重複しても一つに畳み込まれない。',
        ].join('\n'),
      ),
    ),
    documentText(
      fromPlainText(
        [
          '同じ雪国の第二の出現 — a second occurrence keeps its own long mixed-script document.',
          'Continuation stays offered when this page shows no newly visible identity.',
          '空の続きも打ち切りではない。',
        ].join('\n'),
      ),
    ),
  ],
  occurrenceIds: ['01a17a3b-6e78-73b5-9efd-f4cc070cc9e3', '01a17a3b-6e78-73b5-9efd-f4cc070cc9e4'] as const,
  withheldOccurrenceId: '01a17a3b-6e78-73b5-9efd-f4cc070cc9e5',
  withheldSubjectId: '01a17a3b-6c01-77c8-94fd-810a3ae73368',
  next: 'sparse-next',
  emptyCursor: 'sparse-empty',
} as const;

export const collectionStoryDestinationId = '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7bd0';
let destinationRevision = 3;
let destinationMembers: typeof collectionStoryMembers = [];

let mode: CollectionStoryMode = 'many';
let finishPendingCreate: (() => void) | undefined;
const clone = <T>(value: T): T => structuredClone(value);
const members = clone(collectionStoryMembers);
const importedCover: NonNullable<CollectionPresentationData['cover']> = {
  ...subject.summary.cover,
  variants: subject.summary.cover.variants.flatMap((variant) =>
    variant.format === 'avif' || variant.format === 'webp' ? [{ format: variant.format, width: variant.width }] : [],
  ),
};
const baseCollection: Omit<typeof collection.collection, keyof CollectionPresentationData> &
  CollectionPresentationData = {
  ...clone(collection.collection),
  presentationKindSource: 'mixed',
};
let editedCollection: typeof baseCollection & CollectionPresentationData & { coverMediaId?: string | null } =
  clone(baseCollection);
let editedMembers = clone(members);
const removed = new Map<
  string,
  { member: (typeof members)[number]; index: number; deletionId: string; revision: number; deadline: number }
>();
let following = false;
const followResponse = () => ({
  status: 200,
  follow: {
    targetId: baseCollection.id,
    targetType: 'collection',
    state: following ? 'following' : 'unfollowed',
    reason: 'explicit',
    updatedAt: baseCollection.updatedAt,
  },
});
const receipts = new Map<string, KernelRecording>();
let finishPendingSave: (() => void) | undefined;
const itemIds = members.map((member) => member.id);
let editorNavigation = false;
let boundaryUnknownSent = false;
let boundaryReadFails = false;

export function setCollectionStoryMode(next: CollectionStoryMode, editor = false): void {
  mode = next;
  editorNavigation = editor;
  destinationRevision = 3;
  destinationMembers = [];
  editedCollection = clone(baseCollection);
  editedMembers = clone(members);
  boundaryUnknownSent = false;
  boundaryReadFails = false;
  if (next === 'empty') {
    editedMembers = [];
    editedCollection.memberCount = 0;
  }
  if (next === 'one-page') {
    editedMembers = editedMembers.slice(0, 1);
    editedCollection.memberCount = 1;
  }
  if (next === 'notes-duplicates' || next.startsWith('boundary-')) {
    editedMembers.splice(1, 0, {
      ...clone(members[0]!),
      id: '01a17a3b-6e78-73b5-9efd-f4cc070cc9e1',
      note: 'A second occurrence with its own note.',
    });
    editedCollection.memberCount = 5;
  }
  if (next === 'long-notes-sparse') {
    editedMembers = sparseVisibleMembers();
    editedCollection.memberCount = 3;
  }
  if (next.startsWith('boundary-')) {
    editedMembers.unshift({ ...clone(members[3]!), id: '01a17a3b-6e78-73b5-9efd-f4cc070cc9e2' });
    editedCollection.memberCount = editedMembers.length;
  }
  if (next === 'private' || next === 'unlisted' || next === 'public') editedCollection.visibility = next;
  if (next === 'presentation') {
    editedCollection.presentationKind = 'schema:Book';
    editedCollection.presentationKindSource = 'owner';
    editedCollection.coverMediaId = subject.summary.cover.media;
    editedCollection.cover = clone(importedCover);
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
      presentationKindSource: value.presentationKind ? 'owner' : 'mixed',
      coverSource: value.cover ? 'owner' : value.memberCount === 0 ? 'none' : 'pending',
    },
  };
}

function listResponse(request: Request) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  const members = editedMembers;
  if (mode.startsWith('boundary-')) {
    if (boundaryReadFails) {
      boundaryReadFails = false;
      return { status: 503, code: 'unavailable' };
    }
    return {
      status: 200,
      members: cursor ? members.slice(1, 4) : members.slice(0, 1),
      next: cursor ? 'page-three' : 'page-two',
    };
  }
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
  if (mode === 'long-notes-sparse') {
    if (!cursor)
      return {
        status: 200,
        members: [...members, sparseWithheldMember()],
        next: collectionLongNotesSparse.next,
      };
    return {
      status: 200,
      members: [],
      next: cursor === collectionLongNotesSparse.next ? collectionLongNotesSparse.emptyCursor : null,
    };
  }
  return { status: 200, members, next: null };
}

function sparseVisibleMembers(): typeof collectionStoryMembers {
  const source = clone(members[0]!);
  const label = { ...source.subject.label, value: collectionLongNotesSparse.identity };
  return collectionLongNotesSparse.occurrenceIds.map((id, index) => ({
    ...source,
    id,
    note: collectionLongNotesSparse.notes[index]!,
    subject: { ...source.subject, label },
  }));
}

function sparseWithheldMember() {
  return {
    id: collectionLongNotesSparse.withheldOccurrenceId,
    subjectId: collectionLongNotesSparse.withheldSubjectId,
    note: null,
    addedAt: members[0]!.addedAt,
    subject: null,
  };
}

function destinationCollection() {
  return {
    ...clone(baseCollection),
    id: collectionStoryDestinationId,
    curatorAccountId: 'story-viewer',
    title: 'Weekend reading',
    visibility: 'private',
    revision: destinationRevision,
    memberCount: destinationMembers.length,
  };
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: new RegExp(`^/v1/collections/${collectionStoryDestinationId}(/members)?$`),
    story: ({ request, match }) =>
      !request.headers.has('authorization')
        ? { status: 404, code: 'not_found' }
        : match?.[1]
          ? { status: 200, members: clone(destinationMembers), next: null }
          : { status: 200, collection: destinationCollection() },
  },
  {
    method: 'POST',
    path: new RegExp(
      `^/v1/collections/${baseCollection.id}/members(?::(?:batchRemove|move)|/\\$(?:batchRemove|move))$`,
    ),
    story: ({ request }) => writeBatchStory(request),
  },
  {
    method: 'GET',
    path: '/v1/collections',
    story: ({ request }) => {
      if (editorNavigation && new URL(request.url).searchParams.get('curatorAccountId') === 'story-viewer')
        return {
          status: 200,
          collections: [collectionResponse(request).collection, destinationCollection()],
          next: null,
        };
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
    path: new RegExp(`^/v1/follows/${baseCollection.id}$`),
    story: followResponse,
  },
  {
    method: 'PUT',
    path: new RegExp(`^/v1/follows/${baseCollection.id}$`),
    story: () => {
      following = true;
      return followResponse();
    },
  },
  {
    method: 'DELETE',
    path: new RegExp(`^/v1/follows/${baseCollection.id}$`),
    story: () => {
      following = false;
      return followResponse();
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

/** Stateful replay of the delivered atomic commands; all validation precedes fixture mutation. */
async function writeBatchStory(request: Request): Promise<KernelRecording> {
  if (!request.headers.has('authorization')) return { status: 403, code: 'forbidden' };
  if (mode === 'failed-save') return { status: 503, code: 'unavailable' };
  if (mode === 'conflict-save') return { status: 409, code: 'conflict' };
  const key = request.headers.get('idempotency-key');
  if (!key) return { status: 400, code: 'invalid_request' };
  const replay = receipts.get(key);
  if (replay) return clone(replay);
  const body = (await request.json()) as {
    revision: number;
    memberIds: string[];
    destinationCollectionId?: string;
    destinationRevision?: number;
    after?: string | null;
  };
  if (
    !Array.isArray(body.memberIds) ||
    !body.memberIds.length ||
    body.memberIds.length > 100 ||
    new Set(body.memberIds).size !== body.memberIds.length
  )
    return { status: 400, code: 'invalid_request' };
  if (body.revision !== editedCollection.revision) return { status: 409, code: 'conflict' };
  const selected = editedMembers.filter((member) => body.memberIds.includes(member.id));
  if (selected.length !== body.memberIds.length) return { status: 404, code: 'not_found' };
  const moving = /(?::move|\/\$move)$/.test(new URL(request.url).pathname);
  if (
    moving &&
    (body.destinationCollectionId !== collectionStoryDestinationId ||
      body.destinationRevision !== destinationRevision ||
      body.after !== null)
  )
    return { status: 409, code: 'conflict' };
  const revision = editedCollection.revision + 1;
  const episodes = moving
    ? []
    : selected.map((member) => {
        const episode = {
          member: clone(member),
          index: editedMembers.indexOf(member),
          deletionId: crypto.randomUUID(),
          revision,
          deadline: Date.now() + 720 * 60 * 60 * 1000,
        };
        removed.set(member.id, episode);
        return { memberId: member.id, deletionId: episode.deletionId, revision };
      });
  editedMembers = editedMembers.filter((member) => !body.memberIds.includes(member.id));
  editedCollection.revision = revision;
  editedCollection.memberCount -= selected.length;
  let response: KernelRecording;
  if (moving) {
    destinationMembers = [...clone(selected), ...destinationMembers];
    destinationRevision += 1;
    response = {
      status: 200,
      source: collectionResponse(request).collection,
      destination: destinationCollection(),
      members: clone(selected),
    };
  } else response = { status: 200, collection: collectionResponse(request).collection, removed: episodes };
  receipts.set(key, clone(response));
  return response;
}

/** Stateful replay of the existing individual commands. */
async function writeStory(request: Request) {
  const observedCollection = editedCollection;
  if (!request.headers.has('authorization')) return { status: 403, code: 'forbidden' };
  if (mode === 'pending-save' || (mode === 'boundary-pending' && request.method === 'POST'))
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
      if (body.coverMediaId) editedCollection.cover = clone(importedCover);
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
      const index =
        body.after === undefined
          ? rest.length
          : body.after === null
            ? 0
            : rest.findIndex((value) => value.id === body.after) + 1;
      if (body.after !== undefined && body.after !== null && index === 0) return { status: 404, code: 'not_found' };
      rest.splice(index, 0, member);
      editedMembers = rest;
      editedCollection.revision += 1;
      response = { status: 200, member: clone(member) };
    }
  }
  receipts.set(key, clone(response));
  if (request.method === 'POST' && /(?::move|\/\$move)$/.test(path)) {
    if (mode === 'boundary-refresh-failed') boundaryReadFails = true;
    if (mode === 'boundary-unknown' && !boundaryUnknownSent) {
      boundaryUnknownSent = true;
      return { status: 503, code: 'unavailable' };
    }
  }
  return response;
}

export const collectionStoryMemberIds = itemIds;
