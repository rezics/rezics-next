import { expect, test } from 'bun:test';
import { declareBound } from '@rezics/bounds';
import { compileNativePolicyCatalogue } from '../../src/access/policy-core.ts';
import {
  bindCollectionReadOperation,
  collectionDirectoryOperationPlan,
  collectionReadWorkDimensions,
  composeCollectionReadOperation,
} from '../../src/library/collection-directory-bounds.ts';
import { subjectCollectionOperationPlan } from '../../src/library/subject-collection-read-bounds.ts';
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

test('directory and Subject operation declarations freeze all nine axes and release reached terms once', () => {
  const leaf = declareBound({
    candidateKeys: 2,
    nativeRows: 3,
    identityMetadataRows: 4,
    nativePoints: 5,
    witnessKeys: 6,
    statements: 7,
    bytes: 8,
    emptySeeks: 9,
    engineRequests: 10,
  });
  const plan = composeCollectionReadOperation('collection.directory', { page: leaf, nested: leaf });
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.terms)).toBe(true);
  expect(plan.total.engineRequests).toBe(20);
  const operation = bindCollectionReadOperation(plan, {}, {}, 1234);
  operation.consume('page');
  operation.consume('page');
  operation.consume('nested');
  expect(operation.release()).toEqual({ work: collectionReadWorkDimensions(plan.total), engineRequests: 20 });

  const directory = collectionDirectoryOperationPlan({
    limit: 20,
    publicOnly: false,
    ownerManagement: true,
    mountedFullView: true,
    preview: true,
  });
  const subject = subjectCollectionOperationPlan({
    subjectId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    limit: 100,
    mountedFullView: true,
  });
  expect(directory.terms).toHaveProperty('builtinDiscovery');
  expect(directory.terms).toHaveProperty('previewSubjects');
  expect(subject.terms).toHaveProperty('subjectResolution');
  expect(subject.terms).toHaveProperty('subjectCollectionTerminal');
  expect(directory.total.engineRequests).toBe(0);
  expect(subject.total.engineRequests).toBe(0);
});
