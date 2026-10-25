import type { createBarrierProofVerifier, TrustedAccessPorts } from '@rezics/auth';
import type { AuthBindingCapabilities } from './auth-bindings.ts';
import { AuthBindingDeniedError } from './auth-bindings.ts';
import type { createLifecycleInternals, LifecycleFenceReceipt } from './lifecycle.ts';

type Lifecycle = Pick<
  ReturnType<typeof createLifecycleInternals>,
  'advanceAuthenticationFloor' | 'readFenceReceipt' | 'readFenceState'
>;
type Proofs = Pick<ReturnType<typeof createBarrierProofVerifier>, 'verify'>;
type Capabilities = Required<Pick<AuthBindingCapabilities, 'invalidateAccount' | 'authorizeRecovery'>>;
type Ports = Required<Pick<TrustedAccessPorts, 'invalidateAccount' | 'authorizeRecovery'>>;
function allowed(value: unknown): asserts value {
  if (!value) throw new AuthBindingDeniedError();
}

/** Server capabilities, never public mutation handlers. Auth owns the concrete
 * proof verifier closure and its database. Kernel receives neither credentials
 * nor a proof-minting facility. Structural substitutes prove boundary denial only.
 */
export function createAuthBarrierCapabilities({ lifecycle, proofs }: { lifecycle: Lifecycle; proofs: Proofs }) {
  async function commit(
    value: { accountId: string; proofReference?: string; operationKey?: string },
    purpose: 'consent-reduction' | 'recovery',
    previousEpoch: number,
  ): Promise<LifecycleFenceReceipt> {
    const input = { ...value };
    allowed(
      Number.isSafeInteger(previousEpoch) &&
        previousEpoch > 0 &&
        previousEpoch < 2147483647 &&
        typeof input.proofReference === 'string' &&
        /^[a-f0-9]{64}$/.test(input.proofReference) &&
        typeof input.operationKey === 'string' &&
        input.operationKey.length > 0 &&
        input.operationKey.length <= 128 &&
        proofs?.verify,
    );
    const reference = input.proofReference;
    const expected = { accountId: input.accountId, purpose, previousEpoch, operationKey: input.operationKey };
    const resolve = async () => {
      try {
        return await proofs.verify(reference, expected);
      } catch {
        return null;
      }
    };
    const proof = await resolve();
    allowed(
      proof &&
        proof.accountId === expected.accountId &&
        proof.purpose === purpose &&
        proof.previousEpoch === previousEpoch &&
        proof.operationKey === expected.operationKey &&
        /^[a-f0-9]{64}$/.test(proof.digest) &&
        Date.parse(proof.expiresAt) > Date.now(),
    );
    const bound = { ...proof };
    const outcome = await lifecycle.advanceAuthenticationFloor(
      {
        accountId: input.accountId,
        key: input.operationKey,
        purpose,
        expectedMinimumAuthnEpoch: previousEpoch,
        proofReference: reference,
        proofDigest: bound.digest,
        proofExpiresAt: bound.expiresAt,
      },
      async () => {
        const current = await resolve();
        return (
          !!current &&
          current.accountId === bound.accountId &&
          current.purpose === bound.purpose &&
          current.previousEpoch === bound.previousEpoch &&
          current.operationKey === bound.operationKey &&
          current.digest === bound.digest &&
          current.expiresAt === bound.expiresAt
        );
      },
    );
    // Read committed native identity and state, never synthesize a receipt from
    // expected numbers. Supersession after COMMIT denies this Auth effect.
    const receipt = await lifecycle.readFenceReceipt(input.accountId, outcome.value.receiptId);
    const state = await lifecycle.readFenceState(input.accountId);
    allowed(
      receipt &&
        receipt.accountId === input.accountId &&
        receipt.receiptId === outcome.value.receiptId &&
        receipt.minimumAuthnEpoch === outcome.value.minimumAuthnEpoch &&
        receipt.kind === 'fence' &&
        receipt.priorOperatorAccountId === null &&
        receipt.minimumAuthnEpoch === String(previousEpoch + 1) &&
        state &&
        state.minimumAuthnEpoch === receipt.minimumAuthnEpoch &&
        state.receiptId === receipt.receiptId &&
        (purpose !== 'recovery' || state.fenced),
    );
    return receipt;
  }
  const capabilities: Capabilities = {
    async invalidateAccount(input) {
      allowed(input.reason === 'consent-reduction');
      return commit(input, 'consent-reduction', input.previousEpoch);
    },
    authorizeRecovery: (input) => commit(input, 'recovery', input.proofEpoch),
  };
  function translate(receipt: LifecycleFenceReceipt | null) {
    allowed(receipt);
    return {
      receiptId: receipt.receiptId,
      accountId: receipt.accountId,
      minimumAuthnEpoch: Number(receipt.minimumAuthnEpoch),
    };
  }
  // Host ports bypass the older binding's pre-read equality check: exact replay
  // is authorized by the native command receipt, including the original floor.
  const trustedAccess: Ports = {
    invalidateAccount: async (input) => translate(await capabilities.invalidateAccount(input)),
    authorizeRecovery: async (input) => translate(await capabilities.authorizeRecovery(input)),
  };
  return { ...capabilities, trustedAccess };
}
