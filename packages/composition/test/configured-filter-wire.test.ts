import { expect, test } from 'bun:test';
import { bundledRelease } from '../../definitions/src/bundled.ts';
import {
  planReads,
  platformRegistry,
  validateComposition,
  validateDocumentFilters,
  type CompositionDocument,
} from '../src/index.ts';

function document(filter: unknown): CompositionDocument {
  return {
    root: { props: {} },
    content: [
      {
        type: 'TypeList',
        props: { id: 'books', title: 'Books', types: ['schema:Book'], filter, sort: 'name', limit: 2, paged: true },
      },
    ],
  };
}

test('serialized configuration retains the admitted public TypeList predicate and native continuation', () => {
  const filter = { statement: { property: 'schema:wordCount', range: { gte: 1000001, unit: '1' } } };
  const object = document(filter);
  const serialized = document(JSON.stringify(filter));
  expect(validateComposition(platformRegistry, serialized)).toEqual([]);
  expect(validateDocumentFilters(platformRegistry, serialized, bundledRelease)).toEqual([]);
  for (const cursor of [undefined, 'native-opaque-cursor']) {
    const context = { subject: null, ...(cursor ? { continuation: { node: 'books', cursor } } : {}) };
    expect(planReads(platformRegistry, serialized, context)).toEqual(planReads(platformRegistry, object, context));
  }
});

test('serialized configuration cannot admit private operands, arbitrary DSL or invalid JSON', () => {
  for (const filter of [
    JSON.stringify({ owner: { presence: true } }),
    JSON.stringify({ not: { owner: { presence: true } } }),
    JSON.stringify({ query: '*' }),
    JSON.stringify('not a filter'),
    '{',
    ' '.repeat(8193),
  ]) {
    const violations = validateComposition(platformRegistry, document(filter));
    expect(violations.some((violation) => violation.pointer.startsWith('/content/0/props/filter'))).toBe(true);
  }
});
