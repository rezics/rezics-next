import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { preparationDefinitionBases } from '../../src/library/members-preparation.ts';
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
