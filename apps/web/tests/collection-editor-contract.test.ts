import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  createCollectionRecord,
  updateCollectionRecord,
  removeCollectionMemberWithUndoRecord,
  restoreCollectionMemberRecord,
} from '../src/library/collection-records';
import { loadEditableCollectionPage } from '../src/library/collection-load';
import { loadMineCollectionsForOwner } from '../src/library/mine-collections';
import { collectionMemberRatio } from '../src/library/collection-presentation';
import collection from '../src/kernel/recorded/library-collection.json';
import memberPage from '../src/kernel/recorded/library-collection-members.json';
import subject from '../src/kernel/recorded/subject.json';

const collectionId = collection.collection.id;
const memberId = memberPage.members[0]!.id;
const idempotencyKey = '0192f3a0-6c1e-7b2a-9d4e-0000000000aa';
const deletionId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const write = () =>
  new Request('https://site.test/_serverFn/collection', {
    method: 'POST',
    headers: { authorization: 'Bearer owner-token' },
  });
const draft = { title: 'Selected presentation', description: '', visibility: 'private', idempotencyKey };

test('current native metadata preserves omission, explicit clear, exact Type and returned parent CAS without extra reads', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ collection: { ...collection.collection, revision: 8 } }, { status: 200 });
    },
  });
  await createCollectionRecord(
    client,
    write(),
    {},
    { ...draft, presentationKind: 'schema:Book', coverMediaId: subject.summary.cover.media },
  );
  const updated = await updateCollectionRecord(
    client,
    write(),
    {},
    {
      ...draft,
      collectionId,
      revision: 7,
      presentationKind: null,
      coverMediaId: null,
    },
    true,
  );
  await updateCollectionRecord(client, write(), {}, { ...draft, collectionId, revision: 8 });
  expect(updated).toEqual({ ok: true, id: collectionId, revision: 8 });
  expect(requests.map((request) => request.method)).toEqual(['POST', 'PATCH', 'PATCH']);
  expect(await requests[0]!.json()).toMatchObject({
    presentationKind: 'schema:Book',
    coverMediaId: subject.summary.cover.media,
  });
  expect(await requests[1]!.json()).toMatchObject({ revision: 7, presentationKind: null, coverMediaId: null });
  const preserved = await requests[2]!.json();
  expect(preserved).not.toHaveProperty('presentationKind');
  expect(preserved).not.toHaveProperty('coverMediaId');
  for (const request of requests) {
    expect(request.headers.get('authorization')).toBe('Bearer owner-token');
    expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
  }
});

test('one loaded-revision DELETE consumes native receipt headers and Undo replays that exact episode without prefetch or deadline renewal', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === 'DELETE')
        return new Response(null, {
          status: 204,
          headers: {
            'Library-Collection-Member-Deletion-Id': deletionId,
            'Library-Collection-Member-Deletion-Revision': '8',
          },
        });
      return Response.json({ code: 'member_restore_expired', status: 409 }, { status: 409 });
    },
  });
  const deleted = await removeCollectionMemberWithUndoRecord(
    client,
    write(),
    {},
    {
      collectionId,
      memberId,
      revision: 7,
      idempotencyKey,
    },
  );
  expect(deleted).toEqual({
    ok: true,
    id: memberId,
    revision: 8,
    undo: { collectionId, memberId, deletionId, revision: 8 },
  });
  if (!deleted.ok || !deleted.undo) throw new Error('Missing native deletion episode');
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await restoreCollectionMemberRecord(client, write(), {}, { ...deleted.undo, idempotencyKey })).toEqual({
      ok: false,
      reason: 'expired',
    });
  }
  expect(requests).toHaveLength(3);
  expect(requests[0]!.method).toBe('DELETE');
  expect(new URL(requests[0]!.url).searchParams.get('revision')).toBe('7');
  expect(requests[0]!.body).toBeNull();
  for (const request of requests.slice(1)) {
    expect(new URL(request.url).pathname).toBe(`/v1/collections/${collectionId}/members/${memberId}:restore`);
    expect(await request.json()).toEqual({ deletionId, revision: 8 });
  }
});

test('current list/detail presentation stays bounded and public projection conceals editor and hidden-member data without fabricating producers', async () => {
  const calls: Request[] = [];
  let dynamic = false;
  const native = {
    ...collection.collection,
    presentationKind: null,
    presentationKindSource: 'mixed',
    coverSource: 'owner',
    cover: subject.summary.cover,
    coverMediaId: subject.summary.cover.media,
    privateRule: { private: 'must not escape' },
  };
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/v1/collections') return Response.json({ collections: [native], next: null });
      if (dynamic && path.endsWith('/members')) return Response.json({}, { status: 202 });
      if (path.endsWith('/members'))
        return Response.json({
          members: [
            ...memberPage.members.slice(0, 3),
            {
              ...memberPage.members[3],
              subject: null,
              note: 'hidden note',
              facts: { secret: [{ kind: 'code', value: 'hidden' }] },
            },
          ],
          next: 'next-page',
        });
      return Response.json({ collection: { ...native, ...(dynamic ? { membershipKind: 'dynamic' } : {}) } });
    },
  });
  const page = await loadEditableCollectionPage(
    client,
    new Request(`https://site.test/collections/${collectionId}`),
    {},
    { id: collectionId },
    'anonymous',
  );
  if ('preparing' in page) throw new Error('Expected curated Collection');
  expect(page.presentationKind).toBeNull();
  expect(page.presentationKindSource).toBe('mixed');
  expect(page.cover).toEqual(subject.summary.cover);
  expect(page.memberCount).toBeNull();
  expect(page.members).toHaveLength(3);
  expect(page).not.toHaveProperty('coverMediaId');
  expect(page).not.toHaveProperty('privateRule');
  expect(page.members.every((member) => !('facts' in member))).toBe(true);
  expect(JSON.stringify(page)).not.toContain('hidden');
  const mine = await loadMineCollectionsForOwner(client, native.curatorAccountId, 'Bearer owner-token');
  expect(mine.collections[0]?.presentationKindSource).toBe('mixed');
  expect(mine.collections[0]?.memberCount).toBe(4);
  expect(mine.collections[0]).not.toHaveProperty('coverMediaId');
  expect(mine.collections[0]).not.toHaveProperty('preview');
  expect(calls).toHaveLength(3);
  expect(calls.every((request) => request.method === 'GET')).toBe(true);
  expect(calls.slice(0, 2).every((request) => !request.headers.has('authorization'))).toBe(true);
  expect(calls.filter((request) => new URL(request.url).pathname.endsWith('/members'))).toHaveLength(1);
  expect(
    new URL(calls.find((request) => new URL(request.url).pathname.endsWith('/members'))!.url).searchParams.get('limit'),
  ).toBe('100');
  expect(
    collectionMemberRatio(
      { type: 'schema:Book' },
      {},
      {
        'schema:Book': { imageAspect: 'square', keyFacts: [] },
      },
    ),
  ).toBe('1:1');
  dynamic = true;
  expect(
    await loadEditableCollectionPage(client, new Request('https://site.test'), {}, { id: collectionId }, 'anonymous'),
  ).toMatchObject({ preparing: true, presentationKind: null, presentationKindSource: 'mixed', coverSource: 'owner' });
});
