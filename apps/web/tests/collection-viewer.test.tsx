import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CollectionViewerFacts, CollectionMember } from '../src/library/reads';
import { loadEditableCollectionPage } from '../src/library/collection-load';
import {
  collectionMemberReturnAddress,
  collectionViewerActionHref,
  collectionViewerActionsState,
  collectionViewerHasPersonalAction,
  collectionViewerFactForMember,
  collectionViewerProjection,
  collectionViewerVoteCurrent,
} from '../src/library/collection-viewer/model';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import type { SessionEnv } from '../src/session/client';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.test' } }));
const { CollectionReadMembers } = await import('../src/library/collection-page');

const collectionId = '00000000-0000-4000-8000-000000000101';
const subjectId = '00000000-0000-4000-8000-000000000111';
const memberIds = ['00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000202'];
const questionId = '00000000-0000-7000-8000-000000000001';
const stamp = '2026-10-31T00:00:00.000Z';
const members = memberIds.map((id, index) => ({
  id,
  subjectId,
  note: index === 0 ? 'First curator note.' : 'Second curator note.',
  addedAt: stamp,
  subject: { id: subjectId, type: 'schema:Book', types: ['schema:Book'], label: 'Repeated work', cover: null },
}));
const facts: CollectionViewerFacts = {
  state: 'current',
  question: {
    id: questionId,
    revision: 1,
    grain: 'item',
    scale: { min: 0, max: 20, displayStep: 1 },
    meaning: 'Your personal rating',
  },
  rows: [
    {
      rowKey: memberIds[0]!,
      subjectId,
      entry: {
        state: 'present',
        incarnationId: '00000000-0000-4000-8000-000000000301',
        entryState: 'in_progress',
        revision: 7,
      },
      vote: { state: 'present', questionId, questionRevision: 1, units: 14, revision: 9 },
    },
    {
      rowKey: memberIds[1]!,
      subjectId,
      entry: { state: 'absent' },
      vote: { state: 'absent', questionId, questionRevision: 1 },
    },
  ],
};

test('current private facts match duplicate occurrences by exact row key and original subject identity', () => {
  const projection = collectionViewerProjection(facts, { mode: 'session', viewerId: 'reader' }, 'reader', true);
  expect(projection.state).toBe('current');
  expect(collectionViewerFactForMember(projection, members[0] as CollectionMember)).toMatchObject({
    rowKey: memberIds[0],
    entry: { state: 'present', revision: 7 },
  });
  expect(collectionViewerFactForMember(projection, members[1] as CollectionMember)).toMatchObject({
    rowKey: memberIds[1],
    entry: { state: 'absent' },
  });
  expect(
    collectionViewerFactForMember(projection, { ...members[0]!, id: '00000000-0000-4000-8000-000000000299' }),
  ).toBe(undefined);
  expect(collectionViewerVoteCurrent(facts.rows[0]!, facts.question)).toBe(true);
  expect(
    collectionViewerVoteCurrent(facts.rows[0]!, { ...facts.question!, revision: facts.question!.revision + 1 }),
  ).toBe(false);
});

test('anonymous, replaced and unavailable readers never turn projection omission into personal absence', () => {
  expect(collectionViewerProjection(facts, { mode: 'anonymous', viewerId: null }, null, true)).toEqual({
    state: 'withheld',
  });
  expect(collectionViewerProjection(facts, { mode: 'session', viewerId: 'old-reader' }, 'new-reader', true)).toEqual({
    state: 'withheld',
  });
  expect(collectionViewerProjection(facts, { mode: 'session', viewerId: 'reader' }, 'reader', false)).toEqual({
    state: 'withheld',
  });
  expect(collectionViewerProjection(undefined, { mode: 'session', viewerId: 'reader' }, 'reader', true)).toEqual({
    state: 'unavailable',
  });
  const withheld = renderToStaticMarkup(
    createElement(CollectionReadMembers, {
      members: members as CollectionMember[],
      viewerProjection: { state: 'withheld' },
      onCopy: () => undefined,
    }),
  );
  expect(withheld).toContain('First curator note.');
  expect(withheld).not.toContain('In progress');
  expect(withheld).not.toContain('Your rating');
  const unavailableFacts = renderToStaticMarkup(
    createElement(CollectionReadMembers, {
      members: members as CollectionMember[],
      viewerProjection: { state: 'unavailable' },
      onCopy: () => undefined,
    }),
  );
  expect(unavailableFacts).toContain('Your private Library facts are unavailable.');
  expect(unavailableFacts).not.toContain('Not in your Library.');
  const noQuestion = collectionViewerProjection(
    { ...facts, question: null },
    { mode: 'session', viewerId: 'reader' },
    'reader',
    true,
  );
  const unavailableScore = renderToStaticMarkup(
    createElement(CollectionReadMembers, {
      members: members as CollectionMember[],
      viewerProjection: noQuestion,
      onCopy: () => undefined,
    }),
  );
  expect(unavailableScore).toContain('Your personal rating is unavailable.');
  expect(unavailableScore).toContain('Not in your Library.');
  expect(unavailableScore).not.toContain('Your rating: 7');
});

test('subject destination returns to the same filtered page, layout, cursor and occurrence', () => {
  const source = `/en/collections/${collectionId}?cursor=page-two&layout=grid&type=schema%3ABook&f.schema%3Agenre=fiction`;
  const returnTo = collectionMemberReturnAddress(source, memberIds[1]!);
  expect(returnTo).toContain('cursor=page-two');
  expect(returnTo).toContain('layout=grid');
  expect(returnTo).toContain('f.schema%3Agenre=fiction');
  expect(returnTo?.endsWith(`#collection-member-${memberIds[1]}`)).toBe(true);
  const via = subjectVisitReturn(returnTo, 'en');
  expect(via).toBe(returnTo);
  const destination = collectionViewerActionHref(`/en/subjects/${subjectId}/repeated-work`, via);
  expect(new URL(destination!, 'https://rezics.test').searchParams.get('via')).toBe(returnTo);
});

function sessionEnv(): Partial<SessionEnv> {
  return {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'collection:read',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'configured',
    SESSIONS: {
      idFromName: () => 'session',
      get: () => ({
        credential: async () => ({ status: 'active', accessToken: 'fixture', subject: 'reader', csrfToken: 'csrf' }),
      }),
    } as SessionEnv['SESSIONS'],
  };
}

function collectionReadSource(failPrivateProjection = false) {
  const memberCalls: { authorization: string | null; cursor: string | null; limit: string | null }[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const authorization = request.headers.get('authorization');
      if (url.pathname === `/v1/collections/${collectionId}/members`) {
        memberCalls.push({
          authorization,
          cursor: url.searchParams.get('cursor'),
          limit: url.searchParams.get('limit'),
        });
        if (authorization && failPrivateProjection) return Response.json({ unavailable: true }, { status: 503 });
        return Response.json({
          members,
          next: 'page-three',
          ...(authorization ? { viewerFacts: facts } : {}),
        });
      }
      if (url.pathname === '/v1/viewerActions') return Response.json({ resources: [] });
      if (url.pathname.startsWith('/v1/follows/')) return Response.json({ code: 'not_found' }, { status: 404 });
      if (url.pathname === `/v1/collections/${collectionId}`)
        return Response.json({
          collection: {
            id: collectionId,
            membershipKind: 'curated',
            curatorAccountId: 'curator',
            title: 'Shared Collection',
            description: null,
            visibility: 'public',
            memberCount: 8,
            revision: 3,
            createdAt: stamp,
            updatedAt: stamp,
          },
        });
      return Response.json({ code: 'not_found' }, { status: 404 });
    },
  });
  return { client, memberCalls };
}

test('one bounded authenticated member-page projection preserves public duplicate occurrences and pagination', async () => {
  const { client, memberCalls } = collectionReadSource();
  const page = await loadEditableCollectionPage(
    client,
    new Request(`https://rezics.test/en/collections/${collectionId}?cursor=page-two`, {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    }),
    sessionEnv(),
    { id: collectionId, cursor: 'page-two' },
  );
  if ('preparing' in page) throw new Error('Expected a curated Collection page');
  expect(page.visibility).toBeNull();
  expect(page.members.map(({ id, note, subjectId: source }) => [id, note, source])).toEqual([
    [memberIds[0], 'First curator note.', subjectId],
    [memberIds[1], 'Second curator note.', subjectId],
  ]);
  expect(page.next).toBe('page-three');
  expect(page.viewerFacts).toEqual(facts);
  expect(memberCalls).toHaveLength(2);
  expect(memberCalls.map(({ authorization, cursor, limit }) => [Boolean(authorization), cursor, limit])).toEqual([
    [false, 'page-two', '100'],
    [true, 'page-two', '100'],
  ]);
});

test('a failed private projection does not fail or empty the admitted public Collection page', async () => {
  const { client } = collectionReadSource(true);
  const page = await loadEditableCollectionPage(
    client,
    new Request(`https://rezics.test/en/collections/${collectionId}?cursor=page-two`, {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    }),
    sessionEnv(),
    { id: collectionId, cursor: 'page-two' },
  );
  if ('preparing' in page) throw new Error('Expected a curated Collection page');
  expect(page.memberState).toBe('ready');
  expect(page.members.map(({ id }) => id)).toEqual(memberIds);
  expect(page.viewerFacts).toBeUndefined();
});

test('undelivered member action fields never grant from current Entry or vote facts', () => {
  const row = facts.rows[0]!;
  for (const actions of [
    { state: 'current', allowed: [{ action: 'library_entry:update', operations: ['library_entry.put'] }] },
    { state: 'current', allowed: [] },
    { state: 'unavailable' },
  ]) {
    const undocumented = { ...row, actions };
    expect(collectionViewerActionsState(undocumented)).toBe('unavailable');
    expect(collectionViewerHasPersonalAction(undocumented, facts.question)).toBe(false);
  }
  expect(collectionViewerVoteCurrent(row, facts.question)).toBe(true);
  expect(collectionViewerVoteCurrent(row, { ...facts.question!, revision: 2 })).toBe(false);
});

test('filtered rows without native occurrence IDs return to their bounded page without a fabricated anchor', () => {
  const source = `/en/collections/${collectionId}?cursor=page-two&layout=grid&f.schema%3Agenre=fiction`;
  const address = collectionMemberReturnAddress(source);
  expect(address).toBe(source);
  expect(subjectVisitReturn(address, 'en')).toBe(source);
});
