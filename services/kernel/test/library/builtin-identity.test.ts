import { expect, test } from 'bun:test';
import { builtinCollectionId, type BuiltinCollectionKey } from '../../src/library/builtin-identity.ts';
import { routeOf } from '../../src/route/route.ts';
const owner = '00000000-0000-7000-8000-6c6400000001';
const other = '00000000-0000-7000-8000-6c6500000001';
test('logical builtin IDs stay fixed across storage and metadata revisions and stay on the owner route', () => {
  const key = Object.freeze({ kind: 'state', profileId: 'game', stateSetId: 'reading', stateId: 'completed' } as const);
  expect(builtinCollectionId(owner, { kind: 'everything' })).toBe('37b2b4fb-085c-8848-a6eb-6c640aae9b53');
  const before = builtinCollectionId(owner, key);
  expect(before).toBe('9ff34aed-247e-85bd-acc3-6c640b6d67ea');
  expect(builtinCollectionId(owner, structuredClone(key))).toBe(before);
  for (const input of [
    { ...key, profileId: 'recipe' },
    { ...key, stateSetId: 'listening' },
    { ...key, stateId: 'planned' },
    { kind: 'everything' } as const,
  ])
    expect(builtinCollectionId(owner, input)).not.toBe(before);
  expect(builtinCollectionId(other, key)).not.toBe(before);
  expect(routeOf(before)).toBe(0x6c64);
  expect(routeOf(builtinCollectionId(other, key))).toBe(0x6c65);
  expect(key).toEqual({ kind: 'state', profileId: 'game', stateSetId: 'reading', stateId: 'completed' });
  for (const bad of ['', 'bad\n', 'é', 'A', 'x'.repeat(65)]) {
    expect(() => builtinCollectionId(owner, { ...key, stateId: bad })).toThrow();
    expect(() => builtinCollectionId(owner, { ...key, profileId: bad })).toThrow();
    expect(() => builtinCollectionId(owner, { ...key, stateSetId: bad })).toThrow();
  }
  for (const bad of ['', '00000000-0000-4000-8000-6c6400000001', owner.toUpperCase()])
    expect(() => builtinCollectionId(bad, key)).toThrow();
  expect(() => builtinCollectionId(owner, { kind: 'query' } as unknown as BuiltinCollectionKey)).toThrow();
});
