import type { AuthRecoveryPort } from '@rezics/auth-contract';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createLifecycleInternals, LifecycleDeniedError } from './lifecycle.ts';

/** Auth-host composition: retain its service getter, never its pool or private
 * keys. Construct alongside native bindings, then pass trustedAccess to Auth.
 * Only the actual native successful-establishment resolver supplies evidence.
 * Each resolution releases Auth before the native account command checks out.
 * Exact Auth/current credential and Access receipt/account reads are independent
 * point seeks; neither completion nor replay enumerates recovery history.
 */
export function createRecoveryCompletion(config: {
  pool: Pool;
  routeKey: Uint8Array;
  auth: () => AuthRecoveryPort;
  clock?: () => Date;
}) {
  const resolve = (reference: unknown) => config.auth().internal.resolveRecoveryEstablishment(reference);
  return {
    async completeRecovery(reference: string): Promise<void> {
      if (typeof reference !== 'string' || !/^[a-f0-9]{64}$/.test(reference)) throw new LifecycleDeniedError();
      const proof = await resolve(reference);
      if (!proof || !Number.isFinite(Date.parse(proof.expiresAt))) throw new LifecycleDeniedError();
      const key = createHash('sha256')
        .update(
          JSON.stringify(['access-recovery-completion-v1', proof.accountId, proof.receiptId, proof.establishmentId]),
        )
        .digest('hex');
      const binding = JSON.stringify(proof);
      const lifecycle = createLifecycleInternals({
        pool: config.pool,
        routeKey: config.routeKey,
        ...(config.clock ? { clock: config.clock } : {}),
        provisioningEvidence: async () => null,
        async recoveryEvidence(value) {
          const current = await resolve(value);
          return current && JSON.stringify(current) === binding ? current : null;
        },
      });
      await lifecycle.clearFence({ accountId: proof.accountId, key, evidence: reference });
    },
  };
}
