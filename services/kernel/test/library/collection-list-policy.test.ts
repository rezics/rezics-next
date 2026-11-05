import { expect, test } from 'bun:test';
import { compileNativePolicyCatalogue } from '../../src/access/policy-core.ts';
import { specializeCollectionListPolicy } from '../../src/library/collection-list-policy.ts';
import type { ActionCatalogue } from '../../src/request/access.ts';
import type { ResolvedResourceRoles } from '../../src/access/resource-roles.ts';

const actions: ActionCatalogue = new Map([['collection:read', { anonymous: true }]]);
const roles: ResolvedResourceRoles = {
  roles: new Map([['library.collection.owner', ['collection:read']]]),
  types: new Map([['library.collection', { owner: 'library.collection.owner', standing: [] }]]),
};
const catalogue = compileNativePolicyCatalogue(actions, roles);

test('the owner qualification selects the curator branch and the account face retains public floor', () => {
  expect(specializeCollectionListPolicy(catalogue, true)).toMatchObject({ status: 'ready', source: 'curator' });
  expect(specializeCollectionListPolicy(catalogue, false)).toEqual({
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
  expect(specializeCollectionListPolicy(empty, false)).toEqual({ status: 'unavailable' });
});
