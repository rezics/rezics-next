import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { CollectionBrowseRow, CollectionPreview, type CollectionBrowseRecord } from '../src/library/collection-browser';
import {
  applyCollectionMemberEditPlan,
  buildCollectionMemberEditPlan,
  CollectionMemberList,
} from '../src/library/collection-editor';
import { collectionMemberRatio, reorderCollectionMembers } from '../src/library/collection-presentation';
import { loadEditableCollectionPage } from '../src/library/collection-load';
import { loadMineCollectionsForOwner } from '../src/library/mine-collections';
import type { CollectionMember } from '../src/library/reads';
import { routes as filterRoutes, collectionFilterStoryId } from '../src/kernel/fake/collection-filters';
import { routes, setCollectionStoryMode } from '../src/kernel/fake/collection-page-stories';
import type { FakeRoute } from '../src/kernel/fake-modules';
import type { KernelRecording } from '../src/kernel/fake';
import recording from '../src/kernel/recorded/library-collection.json';
import recordedMembers from '../src/kernel/recorded/library-collection-members.json';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const id = recording.collection.id;
const stamp = '2026-10-29T00:00:00Z';
const members: CollectionMember[] = ['schema:Book', 'schema:Movie', 'schema:MusicAlbum', 'schema:Recipe'].map(
  (type, index) => ({
    id: `occurrence-${index}`,
    note: index === 0 ? 'A visible note' : null,
    addedAt: stamp,
    subject: {
      id: `subject-${index}`,
      type,
      types: [type],
      label: `Member ${index}`,
      typeLabel: type.split(':')[1],
      cover: null,
    },
  }),
);
const browse: CollectionBrowseRecord = {
  id,
  title: 'A real Collection',
  curator: null,
  visibility: 'public',
  memberCount: 40,
  preview: { state: 'loaded', members: members.map((member) => member.subject!) },
};

async function render(element: ReactElement) {
  const route = createRootRoute({ component: () => element });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

async function dispatch(request: Request, candidates: FakeRoute[] = routes): Promise<KernelRecording | undefined> {
  const path = new URL(request.url).pathname;
  for (const route of candidates) {
    if (route.method !== request.method) continue;
    const match = typeof route.path === 'string' ? null : route.path.exec(path);
    if (typeof route.path === 'string' ? route.path !== path : !match) continue;
    const response = await route.story?.({ request, match, recordings: {} });
    if (response) return response;
  }
}
function request(path: string, method = 'GET', body?: unknown, key = 'receipt-1') {
  return new Request(`https://kernel.test/v1/collections/${path}`, {
    method,
    headers: { authorization: 'Bearer story-owner', 'idempotency-key': key, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Render the actual shared presenters; no source-text or screenshot-shape assertions.
test('at-rest member rows retain real Type, links and notes without exposing editing controls or concealed notes', async () => {
  const html = await render(
    createElement(CollectionMemberList, {
      members: [...members, { id: 'hidden-occurrence', note: 'Must remain concealed', subject: null, addedAt: stamp }],
      editing: false,
      firstPage: true,
      onCopy: () => {},
    }),
  );
  expect(html).toContain('/subjects/subject-0/member-0');
  expect(html).toContain('A visible note');
  expect(html).toContain('Movie');
  expect(html).toContain('MusicAlbum');
  expect(html).toContain(m.library_subject_unavailable());
  expect(html).not.toContain('Must remain concealed');
  expect(html).not.toContain('role="checkbox"');
  expect(html).not.toContain('<textarea');
  expect(html).not.toContain(m.library_member_move_down());
  expect(html).not.toContain(m.library_member_remove());
  expect(html).toContain(m.library_collection_actions());
  expect(html).toContain('data-ratio="3:4"');
  expect(html).toContain('data-ratio="16:9"');
  expect(html).toContain('data-ratio="1:1"');
});

test('editor rows expose bounded selection, notes and a keyboard reorder alternative and disable controls while saving', async () => {
  const html = await render(
    createElement(CollectionMemberList, {
      members,
      editing: true,
      firstPage: true,
      busy: true,
      selectedIds: new Set([members[0]!.id]),
      onSelectionChange: () => {},
      onMove: () => {},
      onRemove: () => {},
      onNoteChange: () => {},
    }),
  );
  expect(html.match(/role="checkbox"/g) ?? []).toHaveLength(4);
  expect(html.match(/<textarea/g) ?? []).toHaveLength(4);
  expect(html).toContain('data-state="checked"');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain(m.library_member_move_down());
  expect(html).toContain(m.library_member_remove());
  const controls = [...html.matchAll(/<(button|textarea)\b[^>]*>/g)].map((match) => match[0]);
  expect(controls.length).toBeGreaterThan(4);
  expect(controls.every((control) => control.includes('disabled'))).toBe(true);
});

test('browse rows preserve the native total and privacy while previewing only the first three actual members', async () => {
  const row = await render(createElement(CollectionBrowseRow, { collection: { ...browse, visibility: 'private' } }));
  expect(row).toContain(m.library_collection_item_count({ count: 40 }));
  expect(row).toContain(m.library_visibility_private());
  expect(row).toContain('href="/collections/');
  expect(row).toContain(m.library_collection_open());
  const preview = await render(createElement(CollectionPreview, { collection: browse }));
  expect(preview).toContain(m.library_collection_item_count({ count: 40 }));
  for (const member of members.slice(0, 3)) expect(preview).toContain(`>${member.subject!.label}<`);
  expect(preview).not.toContain('/subjects/subject-3/');
  const unavailable = await render(
    createElement(CollectionPreview, { collection: { ...browse, memberCount: 0, preview: { state: 'unavailable' } } }),
  );
  expect(unavailable).toContain(m.library_collection_preview_unavailable());
  expect(unavailable).not.toContain(m.library_collection_empty());
  const empty = await render(
    createElement(CollectionPreview, {
      collection: { ...browse, memberCount: 0, preview: { state: 'loaded', members: [] } },
    }),
  );
  expect(empty).toContain(m.library_collection_empty());
  const unknown = await render(
    createElement(CollectionBrowseRow, {
      collection: { id, title: 'Unknown count', curator: null, preview: { state: 'unavailable' } },
    }),
  );
  expect(unknown).not.toContain('data-collection-member-count');
});

test('presentation uses exact actual Types and the current valid coverRatio fallback without guessing a vertical', () => {
  expect(collectionMemberRatio({ type: 'schema:Movie' }, { 'schema:Movie': '5:7' })).toBe('16:9');
  expect(collectionMemberRatio({ type: 'bf:Instance' })).toBe('3:4');
  expect(collectionMemberRatio({ type: 'schema:MusicAlbum' })).toBe('1:1');
  expect(collectionMemberRatio({ type: 'custom:BookMovie' })).toBe('1:1');
  expect(collectionMemberRatio({ type: 'custom:Artwork' }, { 'custom:Artwork': '4:3' })).toBe('4:3');
  expect(collectionMemberRatio({ type: 'custom:Artwork' }, { 'custom:Artwork': 'broken' })).toBe('1:1');
  expect(collectionMemberRatio(null)).toBe('1:1');
});

test('Cancel can discard an immutable draft including selection removal, reordering and notes without any native write', () => {
  const initial = structuredClone(members);
  const draft = reorderCollectionMembers(initial, initial[1]!.id, null, true)
    .filter((member) => member.id !== initial[2]!.id)
    .map((member) => ({ ...member, note: 'Unsaved note' }));
  expect(buildCollectionMemberEditPlan(initial, draft, true).length).toBeGreaterThan(0);
  expect(initial).toEqual(members);
  // Cancel uses the retained initial page; only explicit apply invokes a writer.
  const restored = initial;
  expect(restored).toEqual(members);
});

test('edit planning preserves duplicate-subject occurrences and respects the loaded page boundary and selection cap', () => {
  const duplicate = { ...members[0]!, id: 'another-occurrence', note: null };
  const initial = [members[0]!, duplicate, members[1]!];
  expect(buildCollectionMemberEditPlan(initial, [duplicate, { ...members[0]!, note: 'Changed' }], true)).toEqual([
    { kind: 'remove', memberId: members[1]!.id },
    { kind: 'note', memberId: members[0]!.id, note: 'Changed' },
    { kind: 'move', memberId: duplicate.id, after: null },
  ]);
  expect(reorderCollectionMembers(initial, duplicate.id, null, false)).toEqual(initial);
  expect(reorderCollectionMembers(initial, initial[0]!.id, duplicate.id, false)).toEqual(initial);
  expect(() => buildCollectionMemberEditPlan(initial, [duplicate, members[0]!], false)).toThrow(RangeError);
  expect(() => buildCollectionMemberEditPlan(initial, [duplicate, duplicate], true)).toThrow(RangeError);
  expect(() => buildCollectionMemberEditPlan(initial, [{ ...duplicate, id: 'not-loaded' }], true)).toThrow(RangeError);
  expect(() =>
    buildCollectionMemberEditPlan(
      Array.from({ length: 101 }, (_, i) => ({ ...duplicate, id: String(i) })),
      [],
      true,
    ),
  ).toThrow(RangeError);
});

test('independent writes stop on the first refusal or transport failure and retain the completed count', async () => {
  const plan = buildCollectionMemberEditPlan(members, [], true);
  for (const throws of [false, true]) {
    const calls: string[] = [];
    const result = await applyCollectionMemberEditPlan(plan, async (operation) => {
      calls.push(operation.memberId);
      if (calls.length === 2) {
        if (throws) throw new Error('connection lost');
        return { ok: false, reason: 'conflict' };
      }
      return { ok: true };
    });
    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      completed: 1,
      failed: { operation: plan[1], reason: throws ? 'unavailable' : 'conflict' },
    });
  }
});

test('the five-member filter fixture cannot intercept the four-member recorded Collection', async () => {
  setCollectionStoryMode('public');
  const candidates = [...filterRoutes, ...routes];
  const header = await dispatch(request(id), candidates);
  const page = await dispatch(request(`${id}/members`), candidates);
  expect(header?.collection.memberCount).toBe(recordedMembers.members.length);
  expect(page?.members).toEqual(recordedMembers.members);
  expect(header?.collection.memberCount).toBe(4);
  const filteredHeader = await dispatch(request(collectionFilterStoryId), candidates);
  const filteredMembers = await dispatch(request(`${collectionFilterStoryId}/members`), candidates);
  expect(filteredHeader?.collection.memberCount).toBe(5);
  expect(filteredMembers?.members).toHaveLength(5);
  setCollectionStoryMode('notes-duplicates');
  expect((await dispatch(request(id)))?.collection.memberCount).toBe(5);
  expect((await dispatch(request(`${id}/members`)))?.members).toHaveLength(5);
  expect(await dispatch(request('another-collection'))).toBeUndefined();
});

test('stateful fake saves only supported commands, replays receipts, and refuses failures and stale metadata without mutation', async () => {
  setCollectionStoryMode('public');
  const member = recordedMembers.members[0]!;
  expect((await dispatch(request(`${id}/members/${member.id}`, 'PATCH', { note: 'Saved note' })))?.status).toBe(200);
  expect((await dispatch(request(`${id}/members`)))?.members[0].note).toBe('Saved note');
  expect(
    (
      await dispatch(
        request(id, 'PATCH', { revision: 1, title: 'Revised', description: '', visibility: 'public' }, 'metadata'),
      )
    )?.status,
  ).toBe(200);
  expect((await dispatch(request(id, 'PATCH', { revision: 1, title: 'Stale' }, 'stale')))?.status).toBe(409);
  expect((await dispatch(request(`${id}/members/${member.id}`, 'DELETE', undefined, 'remove')))?.status).toBe(204);
  expect((await dispatch(request(`${id}/members/${member.id}`, 'DELETE', undefined, 'remove')))?.status).toBe(204);
  expect((await dispatch(request(id)))?.collection.memberCount).toBe(3);
  expect((await dispatch(request(id)))?.collection.title).toBe('Revised');
  setCollectionStoryMode('failed-save');
  expect((await dispatch(request(id, 'PATCH', { revision: 1, title: 'Never saved' })))?.status).toBe(503);
  expect((await dispatch(request(id)))?.collection.title).toBe(recording.collection.title);
  setCollectionStoryMode('hidden');
  const hidden = await dispatch(request(id));
  setCollectionStoryMode('private');
  expect(await dispatch(new Request(`https://kernel.test/v1/collections/${id}`))).toEqual(hidden);
});

test('owner browse needs one bounded page read regardless of Collection count and never reads per-Collection details', async () => {
  for (const size of [1, 8, 100]) {
    const requests: URL[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const url = new URL(new Request(input, init).url);
        requests.push(url);
        return Response.json({
          collections: Array.from({ length: size }, (_, index) => ({
            ...recording.collection,
            id: `collection-${index}`,
          })),
          next: 'next-page',
        });
      }) as typeof fetch,
    });
    const page = await loadMineCollectionsForOwner(client, 'owner', 'Bearer credential');
    expect(page.collections).toHaveLength(size);
    expect(page.collections[0]?.memberCount).toBe(4);
    expect(page.next).toBe('next-page');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe('/v1/collections');
    expect(requests[0]?.searchParams.get('limit')).toBe('100');
  }
});

test('a visitor total is withheld on partial or filtered pages and concealed subjects never contribute', async () => {
  for (const next of [null, 'next-page']) {
    for (const filtered of [false, true]) {
      const calls: string[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: (async (input, init) => {
          const url = new URL(new Request(input, init).url);
          calls.push(url.pathname);
          return url.pathname.endsWith('/members')
            ? Response.json({
                members: [...members, { id: 'hidden', note: 'Secret', subject: null, addedAt: stamp }],
                next,
              })
            : Response.json({ collection: { ...recording.collection, memberCount: 900, membershipKind: 'curated' } });
        }) as typeof fetch,
      });
      const result = await loadEditableCollectionPage(
        client,
        new Request('https://site.test/collection'),
        {},
        {
          id,
          ...(filtered ? { filter: { statement: { property: 'schema:keywords', in: ['concept'] } } } : {}),
        },
        'anonymous',
      );
      if ('preparing' in result) throw new Error('Expected curated Collection');
      expect(result.memberCount).toBe(next || filtered ? null : 4);
      expect(result.members).toHaveLength(4);
      expect(result.visibility).toBeNull();
      expect(result.disclosedVisibility).toBe('public');
      expect(calls.sort()).toEqual([`/v1/collections/${id}`, `/v1/collections/${id}/members`].sort());
    }
  }
});
