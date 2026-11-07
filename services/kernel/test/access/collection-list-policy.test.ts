import { expect, test } from 'bun:test';
import { compileNativePolicyCatalogue } from '../../src/access/policy-core.ts';
import {
  bindCollectionListFilter,
  COLLECTION_AUTHORIZATION_MEMBERSHIPS,
  collectionAuthorizationPreparationWork,
  specializeCollectionListFromCatalogue,
} from '../../src/access/adapters/collection-policy.ts';
import type { ActionCatalogue } from '../../src/request/access.ts';
import type { ResolvedResourceRoles } from '../../src/access/resource-roles.ts';

const actions: ActionCatalogue = new Map([['collection:read', { anonymous: true }]]);
const roles: ResolvedResourceRoles = {
  roles: new Map([['library.collection.owner', ['collection:read']]]),
  types: new Map([['library.collection', { owner: 'library.collection.owner', standing: [] }]]),
};
const catalogue = compileNativePolicyCatalogue(actions, roles);

test('the owner qualification selects the curator branch and the account face retains public floor', () => {
  expect(bindCollectionListFilter(specializeCollectionListFromCatalogue(catalogue, true))).toMatchObject({
    status: 'ready',
    source: 'curator',
  });
  expect(bindCollectionListFilter(specializeCollectionListFromCatalogue(catalogue, false))).toEqual({
    status: 'ready',
    source: 'public',
    parameters: { policy_visibility: 'public' },
  });
});

test('missing or incompatible mounted Collection policy stays unavailable', () => {
  const empty = compileNativePolicyCatalogue(new Map() as ActionCatalogue, {
    roles: new Map(),
    types: new Map(),
  });
  expect(bindCollectionListFilter(specializeCollectionListFromCatalogue(empty, false))).toEqual({
    status: 'unavailable',
  });
  expect(bindCollectionListFilter(specializeCollectionListFromCatalogue(undefined, true))).toEqual({
    status: 'unavailable',
  });
});

test('collection-update authorization preparation keeps the native inverse membership limit', () => {
  const preparation = collectionAuthorizationPreparationWork();
  expect(COLLECTION_AUTHORIZATION_MEMBERSHIPS).toBe(1000);
  expect(preparation.engineRequests).toBe(0);
  expect(preparation.nativeRows).toBeGreaterThan(0);
  expect(preparation.statements).toBeGreaterThan(0);
  expect(preparation.candidateKeys).toBeGreaterThan(0);
});
