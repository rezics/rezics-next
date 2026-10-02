import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { compileQuery, QueryRejected } from '../src/modules/query/compile.ts';
import {
  resourceListQuery,
  type ResourceListQuery,
} from '../src/modules/query/resource-contract.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  WorkReadInvalid,
  WorkReadMoved,
} from '../src/modules/work/read-session.ts';

const base: ResourceListQuery = {
  profile: 'resource-list-v1',
  context: 'global',
  scope: { kind: 'all' },
  sort: 'newest',
};
const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

test('G939: one Query admits every resource owner and descriptive type through the type Facet', () => {
  for (const type of [
    'https://schema.org/CreativeWork',
    'https://rezics.com/vocab/Space',
    'https://rezics.com/vocab/Realm',
    'https://rezics.com/vocab/Zone',
    'https://rezics.com/vocab/Agent',
    'https://rezics.com/vocab/Collection',
    'http://www.w3.org/2004/02/skos/core#Concept',
  ]) {
    const input = { ...base, filter: { all: [{ facet: 'type', any: [type] }] } };
    expect(Value.Check(resourceListQuery, input)).toBe(true);
    expect(compileQuery(input)).toMatchObject({
      template: 'resource-list',
      request: { conditions: [{ facet: 'type', operator: 'any', values: [type] }] },
    });
  }
  expect(compileQuery({ ...base, q: '小说', sort: 'relevance', limit: 64 })).toMatchObject({
    template: 'resource-list',
  });
});

test('G939: Query validates full meaning before graph/index execution', () => {
  expect(() => compileQuery({ ...base, sort: 'relevance' })).toThrow(QueryRejected);
  expect(() => compileQuery({ ...base, limit: 65 })).toThrow(QueryRejected);
  expect(() => compileQuery({ ...base, scope: { kind: 'realm', realm } })).toThrow(QueryRejected);
  expect(() =>
    compileQuery({ ...base, filter: { all: [{ facet: 'contributor', any: [realm] }] } }),
  ).toThrow(QueryRejected);
  expect(
    compileQuery({ ...base, context: { realm }, scope: { kind: 'realm', realm } }),
  ).toMatchObject({ template: 'resource-list' });
});

test('G939: list continuations reject another filter, graph epoch, or changed graph', () => {
  const position = { dataEpoch: 'g939', sequence: '20' };
  const cursor = encodeReadCursor(['public', 'query'], position, realm, '2');
  expect(decodeReadCursor(cursor, ['public', 'query'], position)?.after).toBe(realm);
  expect(() => decodeReadCursor(cursor, ['public', 'other'], position)).toThrow(WorkReadInvalid);
  expect(() =>
    decodeReadCursor(cursor, ['public', 'query'], { ...position, sequence: '21' }),
  ).toThrow(WorkReadMoved);
  expect(() =>
    decodeReadCursor(cursor, ['public', 'query'], { ...position, dataEpoch: 'restored' }),
  ).toThrow(WorkReadMoved);
});
