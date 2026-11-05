import { expect, test } from 'bun:test';
import { Compile } from 'typebox/compile';
import {
  DiscoveryPageSchema,
  admitDiscoveryHit,
  admitDiscoveryPage,
  discoveryHttpPage,
} from '../../src/search/discovery-http.ts';
import type { DiscoveryPage } from '../../src/search/discovery.ts';
import { routeOf } from '../../src/route/route.ts';

const id = '018f0000-0000-7000-8000-00a000000001';
const route = routeOf(id)!;
const date = '2026-11-01T00:00:00Z';
function mixedPage(): DiscoveryPage {
  const hits = [
    {
      key: { owner: 'semantic', kind: 'schema:Person', route, id },
      summary: {
        kind: 'subject',
        value: {
          id,
          type: 'schema:Person',
          types: ['schema:Person'],
          label: { value: 'Mira', language: 'en' },
          creativeWork: false,
          cover: null,
        },
      },
    },
    {
      key: { owner: 'accounts', kind: 'account', route, id },
      summary: {
        kind: 'account',
        value: {
          id,
          accountKind: 'actor',
          handle: 'mira',
          displayName: 'Mira',
          automated: false,
          operatorId: null,
          avatar: null,
          verifiedAgent: { id, label: 'Mira', type: 'schema:Person' },
        },
      },
    },
    {
      key: { owner: 'library', kind: 'collection', route, id },
      summary: {
        kind: 'collection',
        value: {
          id,
          title: 'Library',
          description: null,
          card: {
            kind: 'collection',
            id,
            destination: `/collections/${id}`,
            title: 'Library',
            description: null,
            visibility: 'public',
            revision: 1,
            sourceGeneration: '1',
            presentationKind: null,
            presentationKindSource: 'owner',
            cover: null,
            coverSource: 'none',
            curator: { state: 'unavailable', reason: 'native_projection' },
            preview: { state: 'unavailable' },
            membershipKind: 'curated',
            memberCount: 0,
            orderEpoch: 0,
            createdAt: date,
            updatedAt: date,
          },
        },
      },
    },
    {
      key: { owner: 'content', kind: 'review', route, id },
      summary: {
        kind: 'review',
        value: {
          id,
          kind: 'review',
          title: null,
          author: { displayName: 'Mira', handle: 'mira' },
          subject: { id, title: 'Atlas' },
          excerpt: 'A review',
        },
      },
    },
    {
      key: { owner: 'community', kind: 'space', route, id },
      summary: { kind: 'space', value: { id, title: 'A place', address: 'place', realm: { id, title: 'Realm' } } },
    },
  ];
  const page = {
    hits,
    kinds: { values: [], next: null },
    next: 'opaque-cursor',
    as_of: date,
    viewerFacts: {
      state: 'current',
      question: null,
      rows: [
        {
          rowKey: JSON.stringify(['semantic', 'schema:Person', route, id]),
          subjectId: id,
          entry: { state: 'absent' },
          vote: { state: 'unavailable', reason: 'question' },
        },
      ],
    },
  };
  admitDiscoveryPage(page);
  return page;
}

test('mixed and empty native pages preserve the closed wire, defaults, cursors and private envelope distinctions', () => {
  const native = mixedPage();
  const wire = discoveryHttpPage(native);
  expect(wire as unknown).toEqual({
    ...native,
    hits: native.hits.map((hit) => ({
      ...hit,
      matchEvidence: { state: hit.summary.kind === 'subject' ? 'absent' : 'unsupported' },
    })),
  });
  expect(Compile(DiscoveryPageSchema()).Check(wire)).toBe(true);
  for (const viewerFacts of [
    undefined,
    null,
    { state: 'unavailable' as const, reason: 'identity' as const, retryable: true },
  ]) {
    const empty = {
      hits: [],
      kinds: { values: [], next: null },
      next: null,
      as_of: date,
      ...(viewerFacts === undefined ? {} : { viewerFacts }),
    };
    expect(discoveryHttpPage(empty)).toEqual(empty);
  }
});

test('all response families detach nested identity and profile values from later native mutation', () => {
  const native = mixedPage();
  const wire = discoveryHttpPage(native);
  const retained = structuredClone(wire);
  for (const hit of native.hits) {
    const summary = hit.summary;
    switch (summary.kind) {
      case 'subject':
        summary.value.types.push('schema:Thing');
        break;
      case 'account':
        if (summary.value.verifiedAgent) summary.value.verifiedAgent.label = 'Changed';
        break;
      case 'collection':
        Reflect.set(summary.value.card.curator, 'state', 'changed');
        break;
      case 'review':
        if (summary.value.author) Reflect.set(summary.value.author, 'displayName', 'Changed');
        break;
      case 'space':
        if (summary.value.realm) Reflect.set(summary.value.realm, 'title', 'Changed');
        break;
    }
  }
  if (native.viewerFacts?.state === 'current') Reflect.set(native.viewerFacts.rows[0]!, 'rowKey', 'changed');
  expect(wire).toEqual(retained);
});

test('each family rejects unknown fields and malformed owner, kind, route or summary identity', () => {
  for (const hit of mixedPage().hits) {
    for (const invalid of [
      { ...hit, extra: true },
      { ...hit, summary: { ...hit.summary, value: { ...hit.summary.value, extra: true } } },
      { ...hit, key: { ...hit.key, owner: 'wrong' } },
      { ...hit, key: { ...hit.key, kind: 'wrong' } },
      { ...hit, key: { ...hit.key, route: route + 1 } },
      {
        ...hit,
        summary: { ...hit.summary, value: { ...hit.summary.value, id: '018f0000-0000-7000-8000-00a000000002' } },
      },
    ])
      expect(() => admitDiscoveryHit(invalid)).toThrow('incomplete or malformed');
  }
  const page = mixedPage();
  expect(() => admitDiscoveryPage({ ...page, hits: [...page.hits, page.hits[0]] })).toThrow();
  expect(() => admitDiscoveryPage({ ...page, viewerFacts: { ...page.viewerFacts, rows: [] } })).toThrow();
});
