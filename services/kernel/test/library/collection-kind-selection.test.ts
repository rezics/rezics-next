import { expect, test } from 'bun:test';
import { collectionKind, dominantCollectionKind } from '../../src/library/collection-kind.ts';

test('dominant kind counts canonical subjects and resolves ties by exact TypeId', () => {
  const canonicalTypes = new Map<string, string>();
  for (let occurrence = 0; occurrence < 8; occurrence++) canonicalTypes.set('movie', 'schema:Movie');
  canonicalTypes.set('book', 'schema:Book');
  expect(dominantCollectionKind(canonicalTypes)).toEqual({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
  });
  canonicalTypes.set('second-movie', 'schema:Movie');
  expect(dominantCollectionKind(canonicalTypes)).toEqual({
    presentationKind: 'schema:Movie',
    presentationKindSource: 'members',
  });
  // Insertion order and locale collation cannot change the exact TypeId tie-break.
  const exactTie = new Map([
    ['lower', 'example:a'],
    ['upper', 'example:Z'],
  ]);
  expect(dominantCollectionKind(exactTie)).toEqual({
    presentationKind: 'example:Z',
    presentationKindSource: 'members',
  });
});

test('owner override precedes observation access, including a Type retired from the current release', () => {
  expect(
    collectionKind('example:Retired', {
      get presentationKind(): null {
        throw new Error('An owner override must not read member observations');
      },
      presentationKindSource: 'pending',
    }),
  ).toEqual({ presentationKind: 'example:Retired', presentationKindSource: 'owner' });
});

test('clearing an override preserves the distinction between complete zero and missing observation', () => {
  expect(collectionKind(null, dominantCollectionKind(new Map()))).toEqual({
    presentationKind: null,
    presentationKindSource: 'empty',
  });
  expect(collectionKind(null, { presentationKind: null, presentationKindSource: 'pending' })).toEqual({
    presentationKind: null,
    presentationKindSource: 'pending',
  });
  expect(collectionKind(null, dominantCollectionKind(new Map([['book', 'schema:Book']])))).toEqual({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
  });
});
