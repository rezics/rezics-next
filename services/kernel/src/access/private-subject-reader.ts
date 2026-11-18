import { decidePolicy } from '@rezics/access';
import type { Pool } from 'pg';
import type { Access, AccountActor } from '../request/access.ts';
import { privateSubjectBearer } from './factory.ts';
import { nativePolicyCatalogueForAccess } from './policy-core.ts';

/** Native bearer and ordinary ReadDecisions policy. The batched SQL proves standing, an empty complete
 * membership inverse and exact local denials. Only a visible Subject supplies the public floor.
 */
export function privateSubjectReader(access: Access, actor: AccountActor, pool: Pool) {
  const reader = privateSubjectBearer(access, actor, pool);
  const catalogue = nativePolicyCatalogueForAccess(access);
  const action = catalogue?.actionByName['subject:read'];
  if (
    !reader ||
    !catalogue ||
    !action?.anonymous ||
    action.globalReach ||
    action.authority !== 'resource' ||
    !action.resourceTypes.includes('semantic.subject')
  )
    return null;
  const request = {
    action: 'subject:read',
    resourceType: 'semantic.subject',
    mode: 'ordinary' as const,
    anonymous: false,
    hasPrincipal: false,
  };
  const facts = {
    standing: true,
    assignment: true,
    deadlineLive: true,
    scope: actor.scopes.includes('subject:read'),
    publicFloor: true,
    actor: { actionGrant: null, resourceRoleGrant: null, ownAccount: null, authenticatedBenefit: null },
  };
  // Leave unobserved grants unknown. Admit only if the installed policy decides BOTH branches with this evidence.
  const clear = decidePolicy(catalogue, request, { ...facts, localDenial: false });
  const denied = decidePolicy(catalogue, request, { ...facts, localDenial: true });
  if (clear.decision !== 'allow' || denied.decision !== 'deny') return null;
  return reader;
}
