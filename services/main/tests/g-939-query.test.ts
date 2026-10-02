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
import { knownBrowsePrefix, realmBrowseOrder } from '../src/modules/query/resources.ts';

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

test('G939: filtered mixed-kind windows stop before an unseen higher candidate, including order ties', () => {
  const work = Array.from({ length: 130 }, (_, i) => ({
    id: `w${String(i).padStart(3, '0')}`,
    order: String(1000 - i),
  }));
  const realms = Array.from({ length: 70 }, (_, i) => ({
    id: `r${String(i).padStart(3, '0')}`,
    order: realmBrowseOrder(String(-(1200 - i))),
  }));
  const firstWork = work.slice(0, 64),
    firstRealm = realms.slice(0, 64);
  const first = knownBrowsePrefix(
    [...firstWork, ...firstRealm],
    [firstWork.at(-1)!, firstRealm.at(-1)!],
  );
  // If this entire Realm window is excluded, emitting Work 1000 now would
  // wrongly precede the next Realm 1136. Refill it before emitting the Works.
  expect(first).toEqual(firstRealm);
  const second = knownBrowsePrefix([...firstWork, ...realms.slice(64)], [firstWork.at(-1)!]);
  expect(second.slice(0, 6)).toEqual(realms.slice(64));
  expect(second.slice(6)).toEqual(firstWork);
  expect(realmBrowseOrder('1200')).toBe('1200');
  expect(
    knownBrowsePrefix(
      [
        { id: 'z', order: '10' },
        { id: 'a', order: '10' },
      ],
      [{ id: 'b', order: '10' }],
    ),
  ).toEqual([{ id: 'a', order: '10' }]);
});
