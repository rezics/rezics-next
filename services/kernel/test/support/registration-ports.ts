import { createNativeWorkflowProofPorts, createProvisioningEvidenceVerifier } from '@rezics/auth';
import type { Pool } from 'pg';
import { readAccount } from '../../src/access/account-data.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { routeOf } from '../../src/route/route.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

type Lifecycle = ReturnType<typeof createLifecycleInternals>;
type Pair = { accountId: string; reservationId: string };

/** The workflow Access port a native registration test hands to `createAuthHost`:
 * the kernel's lifecycle internals, a `createPending` that records the native
 * proof, the persisted provisioning reference and evidence, and `readAccount`
 * by the account's route exactly as `createNativeAccountBindings` reads it. */
export function createRegistrationPorts(config: {
  pool: Pool;
  authPool: Pool;
  routeKey: Uint8Array;
  referenceKeys: KeyRing;
  recoveryEvidence?: Parameters<typeof createLifecycleInternals>[0]['recoveryEvidence'];
}) {
  const { pool, authPool, referenceKeys } = config;
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  const registration = createRegistrationProofBindings({ pool, referenceKeys });
  const provisioning = createProvisioningEvidenceVerifier({ database: authPool });
  const internal: Lifecycle = createLifecycleInternals({
    pool,
    routeKey: config.routeKey,
    provisioningEvidence: (evidence) => provisioning.resolve(evidence),
    recoveryEvidence: config.recoveryEvidence ?? (async () => null),
  });
  const ports = {
    ...internal,
    async createPending(input: Parameters<Lifecycle['createPending']>[0]) {
      const outcome = await internal.createPending(input);
      const pair = { accountId: input.accountId, reservationId: input.reservationId };
      if (!(await proofs.pendingReference(pair))) {
        const reference = await registration.createProvisioningReference({ input, outcome });
        if (!reference) throw new Error('Missing native registration reference');
        await proofs.recordPending({ ...pair, reference });
      }
      return outcome;
    },
    async provisioningReference(input: Pair) {
      const reference = await proofs.pendingReference(input);
      if (!reference) throw new Error('Missing persisted registration reference');
      return reference;
    },
    provisioningEvidence: (input: Pair) => proofs.provisioningEvidence(input),
    async readAccount(accountId: string) {
      const route = routeOf(accountId);
      return route === null ? null : readAccount(pool, route, accountId);
    },
  };
  return { ports, internal };
}
