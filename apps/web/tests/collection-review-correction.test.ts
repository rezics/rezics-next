import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollectionMemberList } from '../src/library/collection-editor';
import { loadEditableCollectionPage } from '../src/library/collection-load';
import type { SessionEnv } from '../src/session/client';
import recording from '../src/kernel/recorded/library-collection.json';
import memberRecording from '../src/kernel/recorded/library-collection-members.json';
import { subjectOf, type CollectionMember } from '../src/library/reads';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { batchRemoveCollectionMembersRecord, transferCollectionMembersRecord, collectionSelection } =
  await import('../src/library/collection-commands');

const collectionId = recording.collection.id;
const memberIds = memberRecording.members.slice(0, 2).map((member) => member.id);
const idempotencyKey = '0192f3a0-6c1e-7b2a-9d4e-0000000000aa';
const destinationCollectionId = '0192f3a0-6c1e-7b2a-9d4e-0000000000bb';
const write = () =>
  new Request('https://site.test/_serverFn/collection', {
    method: 'POST',
    headers: { authorization: 'Bearer owner' },
  });

test('Named Collection editor review states remain visibly editable with compact generic rows and native bulk commands while only actual curator known totals render member counts', async () => {
  const members: CollectionMember[] = memberRecording.members.map((member) => ({
    ...member,
    subject: { ...subjectOf(member.subject)!, typeLabel: 'Book' },
  }));
  members[0]!.facts = { 'schema:author': [{ kind: 'item', id: 'author', labels: { en: 'A supplied author' } }] };
  const html = renderToStaticMarkup(
    createElement(CollectionMemberList, {
      members,
      editing: true,
      firstPage: true,
      selectedIds: new Set(memberIds),
      onSelectionChange: () => {},
      onMove: () => {},
      onRemove: () => {},
      onNoteChange: () => {},
    }),
  );
  expect(html.match(/data-slot="checkbox"/g)).toHaveLength(4);
  expect(html.match(/data-drag-handle/g)).toHaveLength(4);
  expect(html.match(/<textarea/g)).toHaveLength(4);
  expect(html).toContain('A supplied author');
  expect(html).toContain('Book');
  expect(html).toContain('grid-cols-');
  expect(html).toContain('data-slot="list-row-link"');
  expect(html).not.toContain('Type:');
  expect(html).not.toContain('text-primary');

  const sessionEnv = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'kernel',
    WEBSITE_SCOPES: 'collection:read',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: () => 'session',
      get: () => ({
        credential: async () => ({
          status: 'active',
          accessToken: 'owner',
          subject: 'curator',
          csrfToken: 'csrf',
        }),
      }),
    } as unknown as SessionEnv['SESSIONS'],
  };
  for (const knownTotal of [91, 0, undefined]) {
    for (const owner of [true, false]) {
      const calls: Request[] = [];
      const client = createKernelClient('https://kernel.test', {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          calls.push(request);
          const path = new URL(request.url).pathname;
          if (path === '/v1/viewerActions') return Response.json({ resources: [] });
          if (path.includes('/follows/')) return Response.json({}, { status: 404 });
          if (path.endsWith('/members'))
            return Response.json({ members: memberRecording.members, next: 'signed-next' });
          return Response.json({
            collection: {
              ...recording.collection,
              membershipKind: 'curated',
              curatorAccountId: owner ? 'curator' : 'someone-else',
              memberCount: knownTotal,
            },
          });
        },
      });
      const page = await loadEditableCollectionPage(
        client,
        new Request('https://site.test/en/collections/' + collectionId, {
          headers: { cookie: `__Host-rezics_session=${'s'.repeat(43)}` },
        }),
        sessionEnv,
        { id: collectionId },
        'session',
      );
      if ('preparing' in page) throw new Error('Expected curated Collection');
      expect(page.memberCount).toBe(owner && knownTotal !== undefined ? knownTotal : null);
      expect(
        calls.find((request) => new URL(request.url).pathname.endsWith('/members'))?.headers.has('authorization'),
      ).toBe(false);
    }
  }
});

test('selected removal and transfer each send one native request with exact IDs, observed CAS, receipt key and native Undo', async () => {
  const requests: Request[] = [];
  const removed = memberIds.map((memberId, index) => ({ memberId, deletionId: `episode-${index}`, revision: 8 }));
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(
        new URL(request.url).pathname.endsWith(':batchRemove')
          ? { collection: { revision: 8 }, removed }
          : { source: { revision: 9 }, destination: { revision: 14 }, members: [] },
      );
    },
  });
  const selection = { collectionId, memberIds, revision: 7, idempotencyKey };
  expect(await batchRemoveCollectionMembersRecord(client, write(), {}, selection)).toEqual({
    ok: true,
    revision: 8,
    undo: removed.map((episode) => ({ collectionId, ...episode })),
  });
  expect(
    await transferCollectionMembersRecord(
      client,
      write(),
      {},
      {
        ...selection,
        revision: 8,
        destinationCollectionId,
        destinationRevision: 13,
        after: null,
      },
    ),
  ).toEqual({ ok: true, revision: 9, destinationRevision: 14 });
  expect(requests).toHaveLength(2);
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    `/v1/collections/${collectionId}/members:batchRemove`,
    `/v1/collections/${collectionId}/members:move`,
  ]);
  expect(await requests[0]!.json()).toEqual({ revision: 7, memberIds });
  expect(await requests[1]!.json()).toEqual({
    revision: 8,
    memberIds,
    destinationCollectionId,
    destinationRevision: 13,
    after: null,
  });
  for (const request of requests) {
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe('Bearer owner');
    expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
  }
  for (const memberIds of [[], ['one', 'one'], Array.from({ length: 101 }, (_, index) => String(index))])
    expect(() => collectionSelection({ ...selection, memberIds })).toThrow();
});
