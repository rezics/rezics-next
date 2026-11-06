import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';

type Proof = { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number };

/** Production registration for identity fixtures: reserve the handle, create the pending account, activate it and
 * claim the handle. Each step is a separately anchored command, so the claim emits its account-claim discovery
 * events. Raw account or handle_claim rows emit none and must not stand in for a claimed identity.
 */
export function createIdentityRegistrar(pool: Pool, routeKey: Uint8Array) {
  const proofs = new Map<object, Proof>();
  const internal = createLifecycleInternals({
    pool,
    routeKey,
    provisioningEvidence: async (evidence) => proofs.get(evidence as object) ?? null,
    recoveryEvidence: async () => null,
  });
  return {
    internal,
    /** Registers an active human actor that owns `handle`. The account ID defaults to the registration target;
     * a caller that needs a particular partition passes a routed ID of its own (the coordinator derives the same
     * kind of ID, and reserveHandle accepts any routed account). */
    async registerActor(handle: string, accountId = internal.registrationTarget(randomUUID())): Promise<string> {
      const claim = await internal.reserveHandle({ handle, accountId, key: randomUUID() });
      const reservationId = claim.value.reservationId;
      await internal.createPending({ handle, accountId, reservationId, key: randomUUID() });
      const evidence = {};
      proofs.set(evidence, { accountId, registrationId: reservationId, authIdentityId: accountId, authnEpoch: 1 });
      await internal.activate({ accountId, evidence, key: randomUUID() });
      await internal.claimHandle({ handle, accountId, reservationId, key: randomUUID() });
      return accountId;
    },
  };
}
