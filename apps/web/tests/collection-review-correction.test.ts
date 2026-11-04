import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildCollectionSaveReviewPlan,
  initialCollectionSaveOutcomes,
  runCollectionSaveSteps,
} from '../src/library/collection-member-edit-plan';
import { CollectionSaveReview } from '../src/library/collection-save-review/review';
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

test('captured review and execution plan keep duplicate occurrences distinct and in the same order', () => {
  const sample = memberRecording.members[0]!;
  const other = memberRecording.members[1]!;
  const initial: CollectionMember[] = [
    { ...sample, id: 'same-subject-a', note: 'A before' },
    { ...sample, id: 'same-subject-b', note: 'B before' },
    { ...other, id: 'other-c', note: null },
    { ...other, id: 'removed-d', note: 'Keep this note in the removal review' },
  ];
  const desired = [
    initial[1]!,
    { ...initial[0]!, note: 'A after' },
    initial[2]!,
  ];
  expect(initial[0]!.subjectId).toBe(initial[1]!.subjectId);
  expect(initial[0]!.id).not.toBe(initial[1]!.id);
  const plan = buildCollectionSaveReviewPlan({
    collectionId,
    revision: 7,
    firstPage: true,
    initial,
    desired,
    before: {
      title: 'Before title',
      description: 'Before description',
      visibility: 'private',
      presentationKind: null,
      coverMediaId: null,
    },
    after: {
      title: 'After title',
      description: 'Before description',
      visibility: 'private',
      presentationKind: null,
      coverMediaId: null,
    },
  });
  expect(plan.steps.map((step) => step.id)).toEqual([
    'metadata',
    'remove:removed-d',
    'note:same-subject-a',
    'move:same-subject-b',
  ]);
  const html = renderToStaticMarkup(
    createElement(CollectionSaveReview, { plan, initial, desired, types: [] }),
  );
  expect([...html.matchAll(/data-review-step="([^"]+)"/g)].map((match) => match[1])).toEqual(
    plan.steps.map((step) => step.id),
  );
  expect(html).toContain('data-member-id="same-subject-a"');
  expect(html).toContain('data-member-id="same-subject-b"');
  expect(html).toContain('Keep this note in the removal review');
  expect(html).toContain('data-operation-kind="remove"');
});

test('partial save reports settled outcomes and retries the original uncertain step without confirmed writes', async () => {
  const initial: CollectionMember[] = memberRecording.members.slice(0, 2).map((member, index) => ({
    ...member,
    id: `partial-${index}`,
    note: `before-${index}`,
  }));
  const desired = initial.map((member, index) => ({ ...member, note: `after-${index}` }));
  const metadata = {
    title: 'Shelf',
    description: null,
    visibility: 'private' as const,
    presentationKind: null,
    coverMediaId: null,
  };
  const plan = buildCollectionSaveReviewPlan({
    collectionId,
    revision: 4,
    firstPage: true,
    initial,
    desired,
    before: metadata,
    after: { ...metadata, title: 'Renamed shelf' },
  });
  const outcomes = initialCollectionSaveOutcomes(plan);
  const calls: { step: string; key: string }[] = [];
  const keys = new Map<string, string>();
  let ambiguousFirstWrite = true;
  const execute = async (step: (typeof plan.steps)[number]) => {
    const key = keys.get(step.id) ?? `captured-key-${keys.size + 1}`;
    keys.set(step.id, key);
    calls.push({ step: step.id, key });
    if (step.id === 'note:partial-0' && ambiguousFirstWrite) {
      ambiguousFirstWrite = false;
      return { stepId: step.id, status: 'unknown' as const, reason: 'unavailable' };
    }
    return {
      stepId: step.id,
      status: 'confirmed' as const,
      targetId: step.id,
      revision: 20 + calls.length,
    };
  };

  const first = await runCollectionSaveSteps(plan.steps, outcomes, execute, () => {});
  expect(first).toEqual({ complete: false, stoppedAt: 1 });
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['confirmed', 'unknown', 'not-sent']);
  expect(outcomes[0]).toMatchObject({ targetId: 'metadata', revision: 21 });
  const originalKey = keys.get('note:partial-0');

  const retry = await runCollectionSaveSteps(plan.steps, outcomes, execute, () => {});
  expect(retry).toEqual({ complete: true, stoppedAt: null });
  expect(calls.map((call) => call.step)).toEqual([
    'metadata',
    'note:partial-0',
    'note:partial-0',
    'note:partial-1',
  ]);
  expect(calls[1]!.key).toBe(calls[2]!.key);
  expect(keys.get('note:partial-0')).toBe(originalKey);
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
  expect(outcomes.slice(1)).toMatchObject([
    { targetId: 'note:partial-0', revision: 23 },
    { targetId: 'note:partial-1', revision: 24 },
  ]);
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
