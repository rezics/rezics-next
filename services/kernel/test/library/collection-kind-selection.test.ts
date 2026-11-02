import { expect, test } from 'bun:test';
import {
  collectionKind,
  dominantCollectionKind,
  reduceConfiguredCollectionKinds,
} from '../../src/library/collection-kind.ts';

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

test('configured reduction takes one highest-ranked vote per canonical item and uses exact stable ID ties', () => {
  expect(
    reduceConfiguredCollectionKinds([
      {
        subjectId: 'subject:one',
        matches: [
          { id: 'kind:low', eligible: true, precedence: 1, result: 'match' },
          { id: 'kind:high', eligible: true, precedence: 2, result: 'match' },
        ],
      },
      {
        subjectId: 'subject:two',
        matches: [{ id: 'kind:low', eligible: true, precedence: 1, result: 'match' }],
      },
      {
        subjectId: 'subject:three',
        matches: [{ id: 'kind:high', eligible: true, precedence: 2, result: 'match' }],
      },
    ]),
  ).toEqual({ status: 'selected', kindId: 'kind:high' });

  expect(
    reduceConfiguredCollectionKinds([
      {
        subjectId: 'subject:one',
        matches: [
          { id: 'kind:Z', eligible: true, precedence: 3, result: 'match' },
          { id: 'kind:a', eligible: true, precedence: 3, result: 'match' },
        ],
      },
      {
        subjectId: 'subject:two',
        matches: [{ id: 'kind:Z', eligible: true, precedence: 3, result: 'match' }],
      },
      {
        subjectId: 'subject:three',
        matches: [{ id: 'kind:a', eligible: true, precedence: 3, result: 'match' }],
      },
    ]),
  ).toEqual({ status: 'selected', kindId: 'kind:Z' });
});

test('configured reduction preserves unknown possible winners as unavailable without admitting unknown ineligible kinds', () => {
  expect(
    reduceConfiguredCollectionKinds([
      {
        subjectId: 'subject:one',
        matches: [
          { id: 'kind:known', eligible: true, precedence: 1, result: 'match' },
          { id: 'kind:unknown', eligible: true, precedence: 2, result: 'unknown' },
        ],
      },
    ]),
  ).toEqual({ status: 'unavailable' });

  expect(
    reduceConfiguredCollectionKinds([
      {
        subjectId: 'subject:one',
        matches: [
          { id: 'kind:known', eligible: true, precedence: 2, result: 'match' },
          { id: 'kind:unknown', eligible: true, precedence: 1, result: 'unknown' },
          { id: 'kind:ineligible', eligible: false, precedence: 10, result: 'unknown' },
        ],
      },
    ]),
  ).toEqual({ status: 'selected', kindId: 'kind:known' });
  expect(reduceConfiguredCollectionKinds([])).toEqual({ status: 'empty' });
});
