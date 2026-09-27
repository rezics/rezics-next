import type { PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { baselineMemberProof } from '../access/baseline.ts';
import { ControlDenied, requirePrincipal } from '../access/topology-control.ts';

/** Rechecked inside the same transaction as each private read or command.
 * Person counting is independent of which of their person Agents is chosen. */
export async function followPrincipal(client: PoolClient, principal: VerifiedPrincipal, agent: string) {
  const identity = await requirePrincipal(client, principal);
  if (!principal.emailVerified || !await baselineMemberProof(client, identity.id, agent)) {
    throw new ControlDenied('A controlled person Agent is required');
  }
  return identity.id;
}
