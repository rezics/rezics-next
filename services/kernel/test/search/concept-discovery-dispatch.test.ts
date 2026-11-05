import { expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import { newId } from '../../src/route/route.ts';
import { checkHits, type Hit } from '../../src/search/disclosure/check.ts';
import type { ConceptFilterExecution, ConceptStatementCut } from '../../src/search/concept-browse-statements.ts';
import type { ConceptBrowseState } from '../../src/search/concept-browse.ts';
import type { IndexedSubject } from '../../src/search/source.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';

const subjectId = newId(10);
const root = newId(10);
const child = newId(10);
const scheme = newId(10);
const property = 'schema:genre';
const observation = 'a'.repeat(64);
const binding = {
  release: 'release',
  graph: 'graph',
  scheme,
  membership: 'membership',
  principal: 'reader',
  request: 'request',
};
const state: ConceptBrowseState = {
  version: 2,
  selection: { property, concept: root, scheme, includeChildren: true },
  binding,
  retained: { id: 'retained', revision: '1' },
};
const cut: ConceptStatementCut = {
  state,
  source: {
    observe: async () => ({ status: 'current', binding }),
    children: async () => {
      throw new Error('A current candidate check must use retained closure membership');
    },
  },
  store: {
    create: async () => {
      throw new Error('Candidate checks must not create retained closure state');
    },
    read: async () => ({ status: 'complete' }),
    advance: async () => null,
    seal: async () => null,
    retire: async () => {},
    contains: async (_state, concept) => concept === root || concept === child,
  },
};
const statement = {
  property,
  value: child,
  qualifiers: [
    { property: 'rezics:sourceTagWeight', value: '2.5', facet: { kind: 'quantity' as const, amount: 2.5, unit: '1' } },
    { property: 'rezics:sourceTagWeightMetric', value: 'vndbTagsRating' },
    { property: 'rezics:spoilerLevel', value: '0', facet: { kind: 'quantity' as const, amount: 0, unit: '1' } },
  ],
};
const execution: ConceptFilterExecution = {
  reader: async (_partition, request, after, limit) => ({
    status: 'current',
    page: {
      statements: [statement],
      examined: 1,
      after: {
        slot: '00000000-0000-4000-8000-000000000001',
        candidate: '00000000-0000-4000-8000-000000000002',
        observation,
      },
      terminal: true,
      complete: true,
      readyPrefix: observation,
    },
    revalidate: async () => 'current',
  }),
  resolveCut: () => cut,
};
const qualifiers = [
  { property: 'rezics:sourceTagWeight', range: { gte: 2, lte: 3, unit: '1' } },
  { property: 'rezics:sourceTagWeightMetric', in: ['vndbTagsRating'] },
  { property: 'rezics:spoilerLevel', in: ['0'] },
];
const filter = (includeChildren: boolean, metric = 'vndbTagsRating'): FilterDocument => ({
  statement: {
    property,
    in: [root],
    concept: { scheme, ...(includeChildren ? { includeChildren: true } : {}) },
    qualifiers: qualifiers.map((qualifier) =>
      qualifier.property === 'rezics:sourceTagWeightMetric' ? { ...qualifier, in: [metric] } : qualifier,
    ),
  },
});
const hit = (subject: IndexedSubject): Hit => ({
  id: subject.id,
  partition: subjectPartition(subject.id),
  securityRevision: subject.securityRevision,
  matched: [],
});

test('Universal current checks match descendant-only work tags with same-statement weight, metric and spoiler evidence', async () => {
  const source = createFakeSource();
  const subject: IndexedSubject = {
    id: subjectId,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [],
    aliases: [],
    descriptions: [],
    statements: [],
  };
  source.put(subject);

  const descendant = await checkHits(source, [hit(subject)], new Map(), {
    filter: filter(true),
    spoilerThreshold: 0,
    conceptFilter: execution,
  });
  expect(descendant.passed.map(({ hit: current }) => current.id)).toEqual([subjectId]);
  expect(descendant.relationRejected).toBeUndefined();

  const exact = await checkHits(source, [hit(subject)], new Map(), {
    filter: filter(false),
    spoilerThreshold: 0,
    conceptFilter: execution,
  });
  expect(exact.passed).toEqual([]);
  expect(exact.relationRejected).toBeUndefined();

  const wrongMetric = await checkHits(source, [hit(subject)], new Map(), {
    filter: filter(true, 'bangumiRating'),
    spoilerThreshold: 0,
    conceptFilter: execution,
  });
  expect(wrongMetric.passed).toEqual([]);
  expect(wrongMetric.relationRejected).toBeUndefined();
});
