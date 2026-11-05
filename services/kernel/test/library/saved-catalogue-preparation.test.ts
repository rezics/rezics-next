import { expect, test } from 'bun:test';
import { releaseDigest } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { FilterDocument } from '@rezics/filter';
import { preparationDefinitionBases, restorePreparationDefinition } from '../../src/library/members-preparation.ts';

const owner = '019a1b2c-3d4e-7f00-8a00-5ab1ec700001';
const collection = '019a1b2c-3d4e-7f00-8a00-5ab1ec700003';
const filter: FilterDocument = { type: { in: ['schema:Book'] } };
const release = { digest: releaseDigest(bundledRelease), value: bundledRelease };
const loadRelease = async (digest: string) => (digest === release.digest ? bundledRelease : null);

test('a catalogue source keeps its own preparation key beside an owner definition with the same predicate', () => {
  const bases = preparationDefinitionBases(owner, collection, [
    { filter, sort: 'id', source: { kind: 'owner' }, release },
    { filter, sort: 'id', source: { kind: 'catalogue' }, release },
  ]);
  expect(bases.map(({ definition }) => definition.source)).toEqual([{ kind: 'owner' }, { kind: 'catalogue' }]);
  expect(new Set(bases.map(({ basisDigest }) => Buffer.from(basisDigest).toString('hex'))).size).toBe(2);
  // Owner keys keep the retained six-part basis; only a catalogue source adds its element.
  expect(bases.map(({ canonicalBasis }) => JSON.parse(canonicalBasis).length)).toEqual([6, 7]);
});

test('retained preparation restores exactly the source it was admitted with', async () => {
  const [ownerBasis, catalogueBasis] = preparationDefinitionBases(owner, collection, [
    { filter, sort: 'id', source: { kind: 'owner' }, release },
    { filter, sort: 'id', source: { kind: 'catalogue' }, release },
  ]);
  expect((await restorePreparationDefinition(owner, collection, ownerBasis!, loadRelease)).source).toEqual({
    kind: 'owner',
  });
  expect((await restorePreparationDefinition(owner, collection, catalogueBasis!, loadRelease)).source).toEqual({
    kind: 'catalogue',
  });
});
