import type { Pool } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { AccessActingContexts } from './contexts.ts';
import { AccessGroups } from './groups.ts';
import { AccessManagedOrganizations } from './managed-organizations.ts';
import { AccessPrivateRecipients } from './private-recipients.ts';
import { AccessRoles } from './roles.ts';

export { representedGrantProof, dispatchRepresentedGrant, type RepresentedGrantProof } from './represented-work-proof.ts';
export { actingContextFailure, actingContextProblemSchemas, actingContextUnavailable } from './acting-context-problems.ts';
export { admissionFailure, authorityFailure, authorityDenied, idempotencyConflict, admissionConflictSchema } from './admission-problems.ts';

export {
  AccessActingContexts, ActingContextDenied, ActingContextInvalid, ActingContextStale,
  ActingContextUnavailable,
} from './contexts.ts';
export { AccessGroups, GroupConflict, GroupDenied, GroupStale, GroupUnavailable } from './groups.ts';
export { AccessManagedOrganizations, type OrgRosterPolicyInput } from './managed-organizations.ts';
export {
  AccessPrivateRecipients, PrivateRecipientConflict, PrivateRecipientDenied, PrivateRecipientStale,
  PrivateRecipientUnavailable,
} from './private-recipients.ts';
export { AccessRoles, RoleConflict, RoleDenied, RoleStale, RoleUnavailable } from './roles.ts';

/** Constructs the Access owners Main wires. Callers use this surface; the owners still decide. */
export function composeAccess(pool: Pool, environment?: WorkActivationEnvironment) {
  return {
    actingContexts: new AccessActingContexts(pool),
    actingContextDiscovery: new AccessActingContexts(pool, environment),
    groups: new AccessGroups(pool),
    managedOrganizations: new AccessManagedOrganizations(pool),
    privateRecipients: new AccessPrivateRecipients(pool),
    roles: new AccessRoles(pool),
  };
}
