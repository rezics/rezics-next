/** Producer Collection list policy and funded authorization-preparation adapter.
 * Library consumes these through AuthorizationCapability; this module retains SQL and specializePolicy.
 */

import { specializePolicy, type PolicyCatalogue, type PolicyFacts } from '@rezics/access';
import { memoizedValue } from '../../memoized.ts';
import type { AccessWorkDimensions } from '../contract/bounds.ts';
import {
  COLLECTION_AUTHORIZATION_ACTOR_MEMBERS,
  COLLECTION_AUTHORIZATION_GRANT_ROLES,
  COLLECTION_AUTHORIZATION_MEMBERSHIPS,
  COLLECTION_UPDATE_ACTION,
  type CollectionListPolicyOutcome,
  type CollectionPolicyPort,
} from '../contract/collection-policy.ts';
import {
  admitCollectionListOutcome,
  collectionListPolicyFacts,
  collectionListPolicyRequest,
  collectionListRequiredResiduals,
  dimensionsFromAccessWork,
  interpretCollectionListResidual,
  sumCollectionAuthorizationWork,
} from '../core/index.ts';
import { nativePolicyCatalogueForAccess } from '../policy-core.ts';
import { bindCollectionListFilter } from '../policy-filter.ts';
import type { Access } from '../../request/access.ts';
import { accessNativeDeclaration } from '../work.ts';
import accountRead from '../account-read.sql';
import permissionAssignment from '../permission-assignment.sql';
import permissionCandidates from '../permission-candidates.sql';
import permissionCheck from '../permission-check.sql';
import permissionInverse from '../permission-inverse.sql';
import permissionMembership from '../permission-membership.sql';
import permissionTime from '../permission-time.sql';
import type {
  CollectionAuthorizationPreparation,
  CollectionListFilter,
  SpecializeCollectionListInput,
} from '../../library/contract/index.ts';

export { bindCollectionListFilter, COLLECTION_AUTHORIZATION_MEMBERSHIPS };

/** Private Collections are visible to their curator alone, including during mutation admission. */
export function collectionMutationIsConcealed(input: {
  actorAccountId: string;
  curatorAccountId: string | null;
  visibility: string;
}): boolean {
  return input.visibility === 'private' && input.curatorAccountId !== input.actorAccountId;
}

export function specializeCollectionListFromCatalogue(
  catalogue: PolicyCatalogue | undefined,
  fullView: boolean,
): CollectionListPolicyOutcome {
  if (!catalogue) return { status: 'unavailable' };
  const specialization = specializePolicy(
    catalogue,
    collectionListPolicyRequest(fullView),
    collectionListPolicyFacts(fullView) as PolicyFacts,
    collectionListRequiredResiduals(fullView),
  );
  if (specialization.status !== 'ready') return { status: 'unavailable' };
  return admitCollectionListOutcome(interpretCollectionListResidual(specialization.residual), fullView);
}

export function specializeCollectionList(input: SpecializeCollectionListInput): CollectionListFilter {
  const catalogue = nativePolicyCatalogueForAccess(input.access as Access);
  return bindCollectionListFilter(specializeCollectionListFromCatalogue(catalogue, input.fullView));
}

const sqlBytes = (query: string) => Buffer.byteLength(query, 'utf8');
const uuidBytes = 36;
const uuid = '0'.repeat(uuidBytes);
const timestamp = '\0'.repeat(64);
const actorAccount = { route: 65535, account_id: uuid };
const accessMembers = COLLECTION_AUTHORIZATION_ACTOR_MEMBERS;
const accessGroups = accessMembers * COLLECTION_AUTHORIZATION_MEMBERSHIPS;
const accessRoles = accessGroups * 2;
const accessFormulaInput = {
  route: 65535,
  action: COLLECTION_UPDATE_ACTION,
  resource_ids: [uuid],
  actor_id: uuid,
  principal_id: uuid,
  deadline: timestamp,
};

function leafDimensions(
  operation: Parameters<typeof accessNativeDeclaration>[0],
  sqlText: string,
  input: unknown,
  shape: Parameters<typeof accessNativeDeclaration>[2],
  statements = 1,
): AccessWorkDimensions {
  const work = accessNativeDeclaration(operation, input, shape).bound;
  return Object.freeze({
    ...dimensionsFromAccessWork(work),
    statements,
    bytes: work.bytes + sqlBytes(sqlText),
  });
}

function transactionControl(text: string): AccessWorkDimensions {
  return Object.freeze({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 1,
    bytes: sqlBytes(text),
  });
}

function collectionAuthorizationPreparationDimensions(): AccessWorkDimensions {
  return memoizedValue(collectionAuthorizationPreparationDimensions, () =>
    sumCollectionAuthorizationWork([
      leafDimensions('time', permissionTime.sql, { at: timestamp }, {}, 1),
      leafDimensions('account-state', accountRead.sql, actorAccount, { targets: 1 }, 1),
      leafDimensions(
        'inverse',
        permissionInverse.sql,
        { ...actorAccount, members: Array.from({ length: accessMembers }, () => actorAccount) },
        { members: accessMembers, groups: COLLECTION_AUTHORIZATION_MEMBERSHIPS },
        accessMembers,
      ),
      leafDimensions(
        'assignment',
        permissionAssignment.sql,
        { route: 65535, principal_id: uuid, request_id: uuid, actor_id: uuid, at: timestamp },
        {},
        1,
      ),
      leafDimensions(
        'membership',
        permissionMembership.sql,
        {
          route: 65535,
          organization_id: uuid,
          member_id: uuid,
          at: timestamp,
          pairs: Array.from({ length: COLLECTION_AUTHORIZATION_MEMBERSHIPS }, () => ({
            route: 65535,
            organization_id: uuid,
            member_id: uuid,
          })),
        },
        { groups: COLLECTION_AUTHORIZATION_MEMBERSHIPS },
        1,
      ),
      leafDimensions(
        'membership',
        permissionMembership.sql,
        {
          pairs: Array.from({ length: COLLECTION_AUTHORIZATION_MEMBERSHIPS }, () => ({
            realmId: uuid,
            accountId: uuid,
          })),
          at: timestamp,
        },
        { groups: COLLECTION_AUTHORIZATION_MEMBERSHIPS },
        1,
      ),
      leafDimensions(
        'candidates',
        permissionCandidates.sql,
        accessFormulaInput,
        {
          targets: 1,
          members: accessMembers,
          roles: accessRoles,
          grantRoles: COLLECTION_AUTHORIZATION_GRANT_ROLES,
          explicit: true,
          global: true,
          assignment: true,
        },
        1,
      ),
      leafDimensions(
        'formula',
        permissionCheck.sql,
        accessFormulaInput,
        {
          targets: 1,
          members: accessMembers,
          roles: accessRoles,
          grantRoles: COLLECTION_AUTHORIZATION_GRANT_ROLES,
          explicit: true,
          global: true,
          assignment: true,
        },
        1,
      ),
      transactionControl('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
      transactionControl('COMMIT'),
      transactionControl('ROLLBACK'),
      Object.freeze({
        candidateKeys: 0,
        nativeRows: 0,
        identityMetadataRows: 0,
        emptySeeks: 2,
        nativePoints: 2,
        witnessKeys: 0,
        statements: 0,
        bytes: 0,
      }),
    ]),
  );
}

/** Funded Access permission-preparation bound. Library adds its Collection authorization row. */
export function collectionAuthorizationPreparationWork(): CollectionAuthorizationPreparation {
  return memoizedValue(collectionAuthorizationPreparationWork, () =>
    Object.freeze({ ...collectionAuthorizationPreparationDimensions(), engineRequests: 0 as const }),
  );
}

export function createCollectionPolicyPorts(): CollectionPolicyPort {
  return {
    catalogueFor(access) {
      return nativePolicyCatalogueForAccess(access as Access);
    },
    specializeFromCatalogue(catalogue, fullView) {
      return specializeCollectionListFromCatalogue(catalogue as PolicyCatalogue | undefined, fullView);
    },
    authorizationPreparation() {
      return collectionAuthorizationPreparationDimensions();
    },
  };
}

export function createLibraryCollectionPolicyMethods(): Readonly<{
  specializeCollectionList(input: SpecializeCollectionListInput): CollectionListFilter;
  collectionAuthorizationPreparation(): CollectionAuthorizationPreparation;
}> {
  return {
    specializeCollectionList,
    collectionAuthorizationPreparation: collectionAuthorizationPreparationWork,
  };
}
