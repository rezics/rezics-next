import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { LIST_COST, listResult } from '../src/api-list.ts';
import { resourceListQuery } from '../src/modules/query/resource-contract.ts';
import { readResourceCursor, resourcePageCursor, type ResourcePageCursor } from '../src/modules/query/resource-cursor.ts';
import { WorkReadInvalid, WorkReadMoved } from '../src/modules/work/read-session.ts';
import { resourceTypeKinds } from '../src/modules/query/work-drive.ts';

const position = { dataEpoch: randomUUID(), sequence: '9223372036854775807' };
const binding = ['all', [], 'newest', 1, ['en', 'zh-Hans']];
const kinds = resourceTypeKinds([], []);
const iri = () => `https://rezics.com/id/${randomUUID()}`;
const query = { profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' }, sort: 'newest', limit: 1 };

test('every mixed-owner continuation fits the admitted cursor and round-trips without truncation', () => {
  for (const order of ['newest', 'updated'] as const) for (const conceptPhase of ['used', 'unused']) {
    // Independent high-entropy identities and 64-bit commits/ranks exercise
    // every source simultaneously, including sparse pages delivering no card.
    const state: ResourcePageCursor = { seen: Number.MAX_SAFE_INTEGER, seeks: {}, done: [],
      directorySource: { dataEpoch: randomUUID(), sequence: position.sequence } };
    for (const kind of kinds) {
      const resource = iri();
      const after = { id: `urn:rezics:search:directory:${kind}:${order}:${'9'.repeat(40)}:${resource.slice(-36)}`,
        score: '0', commit: position.sequence };
      state.seeks[kind] = { id: resource, key: kind === 'work' ? position.sequence
        : kind === 'realm' ? `${randomUUID()}:${position.sequence}`
        : kind === 'concept' ? JSON.stringify(conceptPhase === 'used'
          ? { phase: conceptPhase, count: position.sequence } : { phase: conceptPhase, after })
        : JSON.stringify(after) };
    }
    const cursor = resourcePageCursor(binding, position, state);
    expect(cursor.length).toBeLessThanOrEqual(LIST_COST.cursorCharacters);
    expect(Value.Check(resourceListQuery, { ...query, cursor })).toBe(true);
    expect(readResourceCursor(cursor, binding, position, kinds)).toEqual(state);
    const empty = listResult([], cursor, 23);
    expect(empty).toMatchObject({ complete: false, count: { value: 23, kind: 'at-least' } });
    expect(listResult([], null, 23)).toMatchObject({ complete: true, count: { value: 23, kind: 'exact' } });
  }
});

test('ranked continuation retains native commit, document, score and exact query/graph binding', () => {
  const state: ResourcePageCursor = { seen: 9, seeks: {}, done: [], after: {
    id: `urn:rezics:search:name:resource:${randomUUID()}`, score: '0.000000137',
    commit: position.sequence, document: 2147483647 } };
  const cursor = resourcePageCursor(binding, position, state);
  expect(readResourceCursor(cursor, binding, position, kinds)).toEqual(state);
  expect(() => readResourceCursor(cursor, [...binding, 'changed'], position, kinds)).toThrow(WorkReadInvalid);
  expect(() => readResourceCursor(cursor, binding, { ...position, sequence: '1' }, kinds)).toThrow(WorkReadMoved);
  expect(() => readResourceCursor(`${cursor.slice(0, -10)}aaaaaaaaaa`, binding, position, kinds)).toThrow(WorkReadInvalid);
});

test('generic resource type bindings admit new descriptive classes and mixed owners without a provider table', () => {
  const extension = 'https://example.org/ArchiveObject', book = 'https://schema.org/Book';
  const definitions = [{ type: extension, base: 'resource' }, { type: book, base: 'work' }];
  expect(resourceTypeKinds([{ facet: 'type', operator: 'any', values: [extension] }], definitions)).toEqual(['resource']);
  expect(resourceTypeKinds([{ facet: 'type', operator: 'any', values: [extension, book] }], definitions)).toEqual(['work', 'resource']);
  expect(resourceTypeKinds([{ facet: 'type', operator: 'none', values: [extension] }], definitions)).toEqual(kinds);
  expect(resourceTypeKinds([{ facet: 'type', operator: 'all', values: [extension, book] }], definitions)).toEqual([]);
});
