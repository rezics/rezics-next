import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { preparationDefinitionBases, restorePreparationDefinition } from '../../src/library/members-preparation.ts';
import { definition } from './support/members-preparation-runtime.ts';

test('preparation keys deduplicate only identical accepted owner definitions', () => {
  const owner = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const collection = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
  const selected = definition();
  const [basis] = preparationDefinitionBases(owner, collection, [selected, selected]);
  expect(basis?.canonicalBasis).toBe(
    canonicalize([1, owner, collection, selected.filter, selected.sort, selected.release.digest]),
  );
  expect(basis?.basisDigest).toEqual(createHash('sha256').update(basis!.canonicalBasis).digest());
  expect(preparationDefinitionBases(owner, collection, [selected, { ...selected, sort: 'ordinal' }])).toHaveLength(2);
});

test('retained definitions recover exact immutable meaning and reject invalid bytes before release I/O', async () => {
  const owner = 'owner';
  const collection = 'collection';
  const selected = definition();
  const [retained] = preparationDefinitionBases(owner, collection, [selected]);
  const reads: string[] = [];
  const load = async (digest: string) => {
    reads.push(digest);
    return structuredClone(selected.release.value);
  };
  expect(await restorePreparationDefinition(owner, collection, retained!, load)).toEqual(selected);
  expect(reads).toEqual([selected.release.digest]);
  reads.length = 0;
  for (const [addressedOwner, addressedCollection, bytes] of [
    ['foreign', collection, retained!.canonicalBasis],
    [owner, 'foreign', retained!.canonicalBasis],
    [owner, collection, ` ${retained!.canonicalBasis}`],
    [owner, collection, canonicalize([2, owner, collection, selected.filter, 'id', selected.release.digest])!],
  ]) {
    const canonicalBasis = bytes!;
    await expect(
      restorePreparationDefinition(
        addressedOwner!, addressedCollection!,
        { canonicalBasis, basisDigest: createHash('sha256').update(canonicalBasis).digest() }, load,
      ),
    ).rejects.toMatchObject({ code: 'unsupported_query' });
  }
  await expect(restorePreparationDefinition(owner, collection, { ...retained!, basisDigest: new Uint8Array(32) }, load))
    .rejects.toMatchObject({ code: 'unsupported_query' });
  expect(reads).toEqual([]);
  await expect(restorePreparationDefinition(owner, collection, retained!, async () => null))
    .rejects.toMatchObject({ code: 'dependency_unavailable' });
  await expect(restorePreparationDefinition(owner, collection, retained!, async () => ({ ...selected.release.value, types: {} })))
    .rejects.toMatchObject({ code: 'unsupported_query' });
});
