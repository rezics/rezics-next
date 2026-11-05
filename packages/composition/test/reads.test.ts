import { expect, test } from 'bun:test';
import {
  MAX_PAGE_READS,
  planReads,
  platformRegistry,
  readCost,
  shownProperties,
  validateComposition,
} from '../src/index.ts';

const subject = '018f0000-0000-7000-8000-00a000000001';
const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const list = (id: string, property: string, limit = 12) => node('SubjectList', id, { title: 'Works', property, limit });
const page = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });
const document = page(
  node('SubjectHeader', 'header'),
  node('Stack', 'body', {
    gap: 'md',
    children: [
      node('Statements', 'facts', { properties: ['schema:author', 'schema:datePublished'] }),
      list('works', 'schema:author'),
      node('MoreStatements', 'more'),
    ],
  }),
  node('Statements', 'ids', { properties: ['schema:isbn', 'schema:author'] }),
  list('same', 'schema:author'),
  list('series', 'schema:isPartOf', 6),
);
/** A subject list reads the inverse links, which the kernel orders by the property's declared key. */
const inverse = (property: string, limit: number) => ({ kind: 'links' as const, id: subject, property, limit });

test('data components are part of the platform registry and validate', () => {
  expect(validateComposition(platformRegistry, document)).toEqual([]);
  expect(
    validateComposition(
      platformRegistry,
      page(
        node('Statements', 'a', { properties: [] }),
        node('Statements', 'b', { properties: ['schema:author', 'schema:author'] }),
        node('Statements', 'c'),
        node('SubjectList', 'd', { title: 'Works', property: 'schema:author', limit: 25 }),
        node('SubjectList', 'e', { title: '<script>alert(1)</script>', property: 'schema:author', limit: 0 }),
        node('SubjectHeader', 'f', { text: 'x' }),
      ),
    ),
  ).toEqual([
    { pointer: '/content/0/props/properties', code: 'invalid' },
    { pointer: '/content/1/props/properties', code: 'invalid' },
    { pointer: '/content/2/props/properties', code: 'invalid' },
    { pointer: '/content/3/props/limit', code: 'limit' },
    { pointer: '/content/4/props/limit', code: 'limit' },
    { pointer: '/content/4/props/title', code: 'unsafe' },
    { pointer: '/content/5/props/text', code: 'invalid' },
  ]);
});

test('a page plans one read per distinct descriptor and maps every data node to it', () => {
  const before = structuredClone(document);
  const plan = planReads(platformRegistry, document, { subject });
  expect(plan.reads).toEqual({
    r0: { kind: 'subject', id: subject },
    r1: inverse('schema:author', 12),
    r2: inverse('schema:isPartOf', 6),
  });
  expect(plan.nodes).toEqual({
    header: 'r0',
    facts: 'r0',
    works: 'r1',
    more: 'r0',
    ids: 'r0',
    same: 'r1',
    series: 'r2',
  });
  expect(document).toEqual(before);
  expect(planReads(platformRegistry, page(node('Heading', 'title', { text: 'Books', level: 2 })), { subject })).toEqual(
    { reads: {}, nodes: {} },
  );
});

test('a page without a subject plans no subject reads', () => {
  expect(planReads(platformRegistry, document, { subject: null })).toEqual({ reads: {}, nodes: {} });
});

test('subject data components plan bounded links, public collections and reaction reads', () => {
  const overview = page(
    node('RelationGroups', 'roles', {
      property: 'wdt:P725',
      filter: subject,
      type: 'schema:Person',
      limit: 12,
    }),
    node('CollectionList', 'collections', { title: 'Collections', limit: 6 }),
    node('ReactionSummary', 'reactions'),
  );
  expect(validateComposition(platformRegistry, overview)).toEqual([]);
  const plan = planReads(platformRegistry, overview, { subject });
  expect(plan.reads).toEqual({
    r0: { kind: 'links', id: subject, property: 'wdt:P725', filter: subject, type: 'schema:Person', limit: 12 },
    r1: { kind: 'collections', id: subject, limit: 6 },
    r2: { kind: 'reactions', id: subject },
  });
  expect(plan.nodes).toEqual({ roles: 'r0', collections: 'r1', reactions: 'r2' });
  expect(Object.values(plan.reads).map(readCost)).toEqual([12, 6, 1]);
  expect(planReads(platformRegistry, overview, { subject: null })).toEqual({ reads: {}, nodes: {} });
  expect(
    validateComposition(
      platformRegistry,
      page(node('RelationGroups', 'bad', { property: 'wdt:P725', filter: 'not-a-uuid', limit: 12 })),
    ),
  ).toEqual([{ pointer: '/content/0/props/filter', code: 'unsafe' }]);
});

test('a document needing more than sixteen distinct reads is refused at publish', () => {
  expect(MAX_PAGE_READS).toBe(16);
  const lists = (count: number) => Array.from({ length: count }, (_, i) => list(`l${i}`, 'schema:author', i + 1));
  const full = page(node('SubjectHeader', 'header'), ...lists(MAX_PAGE_READS - 1), list('again', 'schema:author', 1));
  expect(validateComposition(platformRegistry, full)).toEqual([]);
  expect(Object.keys(planReads(platformRegistry, full, { subject }).reads)).toHaveLength(MAX_PAGE_READS);
  const over = page(node('SubjectHeader', 'header'), ...lists(MAX_PAGE_READS));
  expect(validateComposition(platformRegistry, over)).toEqual([{ pointer: '/content', code: 'limit' }]);
  expect(() => planReads(platformRegistry, over, { subject })).toThrow();
  const many = page(
    ...Array.from({ length: 200 }, (_, i) => node('Statements', `s${i}`, { properties: ['schema:author'] })),
  );
  expect(validateComposition(platformRegistry, many)).toEqual([]);
  expect(Object.keys(planReads(platformRegistry, many, { subject }).reads)).toHaveLength(1);
});

test('statements shown by the page are listed once in document order', () => {
  expect(shownProperties(document)).toEqual(['schema:author', 'schema:datePublished', 'schema:isbn']);
  expect(shownProperties(page(node('MoreStatements', 'more')))).toEqual([]);
});
