import { expect, test } from 'bun:test';
import { PAGE_GLOBAL_CONTEXT, planReads, platformRegistry, readCost, validateComposition } from '../src/index.ts';

const subject = '018f0000-0000-7000-8000-00a000000001';
const role = '018f0000-0000-7000-8000-00a000000002';
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const page = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });

const overview = page(
  node('Cover', 'cover'),
  node('Summary', 'summary'),
  node('RelationGroups', 'relations', { property: 'schema:isPartOf', limit: 12 }),
  node('Appearances', 'characters', { property: 'schema:character', direction: 'forward', limit: 12 }),
  node('Credits', 'credits', { property: 'wdt:P725', filter: role, type: 'schema:Person', limit: 12 }),
  node('RatingSummary', 'ratings'),
  node('ThreadList', 'threads'),
  node('ReviewList', 'reviews'),
  node('CollectionList', 'lists', { title: 'Lists', limit: 6 }),
  node('Sources', 'sources'),
);

test('the subject data components are registered with closed props and validate', () => {
  expect(validateComposition(platformRegistry, overview)).toEqual([]);
  expect(
    validateComposition(platformRegistry, page(node('Cover', 'cover', { extra: true }))).map(({ code }) => code),
  ).toEqual(['invalid']);
  expect(
    validateComposition(platformRegistry, page(node('Credits', 'credits', { property: 'wdt:P725', limit: 25 }))),
  ).toEqual([{ pointer: '/content/0/props/limit', code: 'limit' }]);
});

test('subject data components plan the page read kinds and share the subject read', () => {
  const plan = planReads(platformRegistry, overview, { subject });
  expect(Object.values(plan.reads)).toEqual([
    { kind: 'subject', id: subject },
    { kind: 'links', id: subject, property: 'schema:isPartOf', limit: 12 },
    { kind: 'relations', id: subject, property: 'schema:character', limit: 12 },
    { kind: 'links', id: subject, property: 'wdt:P725', filter: role, type: 'schema:Person', limit: 12 },
    {
      kind: 'subjectThreads',
      id: subject,
      place: PAGE_GLOBAL_CONTEXT,
      threadKind: 'discussion',
      limit: 6,
    },
    {
      kind: 'subjectThreads',
      id: subject,
      place: PAGE_GLOBAL_CONTEXT,
      threadKind: 'review',
      limit: 6,
    },
    { kind: 'collections', id: subject, limit: 6 },
  ]);
  // Cover, Summary and Sources share the subject read; forward Appearances uses the outbound relations stream.
  const subjectKey = plan.nodes.cover;
  expect([plan.nodes.summary, plan.nodes.sources]).toEqual([subjectKey, subjectKey]);
  expect(plan.nodes.characters).not.toBe(subjectKey);
  expect(Object.values(plan.reads).reduce((total, read) => total + readCost(read), 0)).toBe(
    1 + 12 + 12 + 12 + 6 + 6 + 6,
  );
});

test('RatingSummary plans no read; threads and reviews plan subject-thread reads', () => {
  const plan = planReads(
    platformRegistry,
    page(node('RatingSummary', 'ratings'), node('ThreadList', 'threads'), node('ReviewList', 'reviews')),
    { subject },
  );
  expect(plan).toEqual({
    reads: {
      r0: {
        kind: 'subjectThreads',
        id: subject,
        place: PAGE_GLOBAL_CONTEXT,
        threadKind: 'discussion',
        limit: 6,
      },
      r1: {
        kind: 'subjectThreads',
        id: subject,
        place: PAGE_GLOBAL_CONTEXT,
        threadKind: 'review',
        limit: 6,
      },
    },
    nodes: { threads: 'r0', reviews: 'r1' },
  });
});

test('subject data components read nothing without a page subject', () => {
  expect(planReads(platformRegistry, overview, { subject: null })).toEqual({ reads: {}, nodes: {} });
});
