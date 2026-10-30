import { expect, test } from 'bun:test';
import { bundledRelease } from '../../definitions/src/bundled.ts';
import {
  planReads,
  platformRegistry,
  validateComposition,
  validateDocumentFilters,
  type CompositionDocument,
} from '../src/index.ts';

const filter = { statement: { property: 'schema:wordCount', range: { gte: 1000001, unit: '1' } } };
const document = (value: unknown = filter): CompositionDocument => ({
  root: { props: {} },
  content: [
    {
      type: 'TypeList',
      props: {
        id: 'books',
        title: { en: 'Long books' },
        types: ['schema:Book'],
        sort: 'name',
        limit: 24,
        filter: value,
      },
    },
  ],
});

test('TypeList intersects the admitted public filter with every configured type and continues one node', () => {
  const doc = document();
  doc.content.push({ ...doc.content[0]!, props: { ...doc.content[0]!.props, id: 'other-books' } });
  expect(validateComposition(platformRegistry, doc)).toEqual([]);
  expect(validateDocumentFilters(platformRegistry, doc, bundledRelease)).toEqual([]);
  const plan = planReads(platformRegistry, doc, {
    subject: null,
    continuation: { node: 'books', cursor: 'opaque-native' },
  });
  expect(plan.nodes.books).not.toBe(plan.nodes['other-books']);
  expect(plan.reads[plan.nodes.books!]).toEqual({
    kind: 'search',
    cursor: 'opaque-native',
    body: {
      filter: { and: [{ type: { in: ['schema:Book'] } }, filter] },
      sort: 'name',
      limit: 24,
    },
  });
  expect(plan.reads[plan.nodes['other-books']!]).not.toHaveProperty('cursor');
});

test('public TypeList configuration rejects OwnerLeaf, arbitrary DSL and combined grammar overflow', () => {
  for (const value of [
    { owner: { presence: true } },
    { not: { owner: { presence: true } } },
    { query: '*' },
    { account: 'other' },
  ])
    expect(validateComposition(platformRegistry, document(value)).length).toBeGreaterThan(0);
  const full = { and: Array.from({ length: 32 }, () => filter) };
  expect(validateComposition(platformRegistry, document(full))).toContainEqual({
    pointer: '/content/0/props/filter',
    code: 'limit',
  });
});

test('release admission rejects unavailable properties and saved owner filters before publication', () => {
  const doc = document({ saved: 'books/private' });
  expect(validateComposition(platformRegistry, doc)).toEqual([]);
  expect(
    validateDocumentFilters(platformRegistry, doc, {
      ...bundledRelease,
      filters: { 'books/private': { filter: { owner: { presence: true } } } },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    validateDocumentFilters(
      platformRegistry,
      document({ statement: { property: 'schema:missing', in: ['x'] } }),
      bundledRelease,
    ).length,
  ).toBeGreaterThan(0);
});
