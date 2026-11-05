import { accessClock } from './access-clock.ts';
import { systemClock } from '../clock.ts';
import { deadlineFor } from '../request/deadline.ts';
import type { Access } from '../request/access.ts';
import { requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';
import type { CredentialFloorPort, CredentialFloorReceipt } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { runCommand, authoritativeTimeValue, type CommandAttempt } from '../command/command.ts';
import { partitionOf, routeOf, newId } from '../route/route.ts';
import { readAccount } from './account-data.ts';
import credentialRead from './auth-barriers-credential-read.sql';
import credentialAdvance from './auth-barriers-credential-advance.sql';
import type { BarrierProofPort, TrustedAccessPorts } from '@rezics/auth-contract';
import type { AuthBindingCapabilities } from './auth-bindings.ts';
import { AuthBindingDeniedError } from './auth-bindings.ts';
import type { createLifecycleInternals, LifecycleFenceReceipt } from './lifecycle.ts';
import { openingManagement } from './operator.ts';

type Lifecycle = Pick<
  ReturnType<typeof createLifecycleInternals>,
  'advanceAuthenticationFloor' | 'readFenceReceipt' | 'readFenceState' | 'confirmBarrier' | 'completeConsentBarrier'
>;
type Proofs = Pick<BarrierProofPort, 'verify'>;
type Capabilities = Required<Pick<AuthBindingCapabilities, 'invalidateAccount' | 'authorizeRecovery'>>;
type Ports = Required<
  Pick<TrustedAccessPorts, 'invalidateAccount' | 'authorizeRecovery' | 'confirmBarrier' | 'completeBarrier'>
>;
const AUTH_BARRIER_BUDGET_MS = 3_000;
function allowed(value: unknown): asserts value {
  if (!value) throw new AuthBindingDeniedError();
}

/** Server capabilities, never public mutation handlers. Auth owns the concrete
 * proof verifier closure and its database. Kernel receives neither credentials
 * nor a proof-minting facility. Structural substitutes prove boundary denial only.
 */
export function createAuthBarrierCapabilities({
  lifecycle,
  proofs,
  access,
}: {
  lifecycle: Lifecycle;
  proofs: Proofs;
  access?: Access;
}) {
  async function commit(
    value: { accountId: string; proofReference?: string; operationKey?: string; openingReceiptId?: string },
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
    // Only a consent reduction from an operator-opened session names its opening.
    const openingReceiptId = purpose === 'consent-reduction' ? input.openingReceiptId : undefined;
    allowed(input.openingReceiptId === openingReceiptId);
    const expected = {
      accountId: input.accountId,
      purpose,
      previousEpoch,
      operationKey: input.operationKey,
      ...(openingReceiptId === undefined ? {} : { openingReceiptId }),
    };
    const resolve = async () => {
      try {
        return await proofs.verify(reference, expected);
      } catch (error) {
        throwAccessUnavailable(error);
        throw error;
      }
    };
    const proof = await resolve();
    allowed(
      proof &&
        proof.accountId === expected.accountId &&
        proof.purpose === purpose &&
        proof.previousEpoch === previousEpoch &&
        proof.operationKey === expected.operationKey &&
        proof.openingReceiptId === openingReceiptId &&
        /^[a-f0-9]{64}$/.test(proof.digest) &&
        Date.parse(proof.expiresAt) > (access ? accessClock(access) : systemClock)().getTime(),
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
        ...(openingReceiptId === undefined ? {} : { openingReceiptId }),
      },
      async () => {
        const current = await resolve();
        return (
          !!current &&
          current.accountId === bound.accountId &&
          current.purpose === bound.purpose &&
          current.previousEpoch === bound.previousEpoch &&
          current.operationKey === bound.operationKey &&
          current.openingReceiptId === bound.openingReceiptId &&
          current.digest === bound.digest &&
          current.expiresAt === bound.expiresAt
        );
      },
      // The operator commands built on this Access decide whether the opening's human still manages the operator.
      openingReceiptId === undefined || !access ? undefined : openingManagement(access),
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
        state.fenced &&
        // A consent barrier on an already fenced account leaves that fence and its receipt in place.
        (purpose === 'consent-reduction' || state.receiptId === receipt.receiptId),
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
    async confirmBarrier(input) {
      return await lifecycle.confirmBarrier({ ...input });
    },
    async completeBarrier(input) {
      allowed(input.purpose === 'consent-reduction');
      await lifecycle.completeConsentBarrier({ ...input });
    },
  };
  return { ...capabilities, trustedAccess };
}

/** Dedicated credential barrier. The trusted native reader rechecks the consumed
 * opening, stage and current formula before every attempt, including exact replay.
 * Neither consent/recovery purpose nor their proof formats enter this command.
 */
export function createCredentialFloorHook(config: {
  pool: Pool;
  access?: Access;
  validate(
    input: Parameters<CredentialFloorPort>[0],
    prior: CredentialFloorReceipt | null,
    attempt: CommandAttempt,
  ): Promise<void>;
}): CredentialFloorPort {
  return async (value) => {
    const input = structuredClone(value);
    const deadline = input.deadline ?? deadlineFor(AUTH_BARRIER_BUDGET_MS);
    input.deadline = deadline;
    requireAccessDeadline(deadline);
    const { stage, consumedOpening: opening, expectedPreviousFloor: previous } = input;
    const route = routeOf(stage.subjectAccountId);
    allowed(
      route !== null &&
        Number.isSafeInteger(previous) &&
        previous > 0 &&
        previous < 2147483647 &&
        input.key === stage.operationKey &&
        input.purpose === stage.purpose &&
        (stage.purpose === 'remove-password' ||
          stage.purpose === 'remove-key' ||
          stage.purpose === 'remove-passkey' ||
          (stage.purpose === 'set-password' && stage.credentialRowId !== null)),
    );
    const parameters = { route, account_id: stage.subjectAccountId, opening_receipt_id: opening.receiptId };
    async function receipt(): Promise<CredentialFloorReceipt | null> {
      const row = await credentialRead.run(config.pool, parameters);
      return row
        ? {
            ...row,
            purpose: row.purpose as CredentialFloorReceipt['purpose'],
            previousFloor: Number(row.previousFloor),
            minimumAuthnEpoch: Number(row.minimumAuthnEpoch),
          }
        : null;
    }
    const { deadline: _deadline, ...operation } = input;
    const digest = createHash('sha256').update(canonicalize(operation)!).digest();
    const result = await runCommand(
      config.pool,
      {
        partition: partitionOf(route),
        clock: config.access ? accessClock(config.access) : systemClock,
        deadline,
        authorization: {
          action: 'credential-floor',
          resource: { route, id: stage.subjectAccountId },
          denied: () => new AuthBindingDeniedError(),
          async prepare(attempt) {
            await config.validate(input, await receipt(), attempt);
            return true;
          },
          async authorize(tx, attempt, proof) {
            requireAccessDeadline(deadline);
            allowed(proof === true && Date.parse(opening.expiresAt) > Date.parse(authoritativeTimeValue(attempt.time)));
            const account = await readAccount(tx, route!, stage.subjectAccountId);
            allowed(account && account.state === 'active' && account.kind === 'actor' && !account.fenced);
            allowed(
              account.minimumAuthnEpoch === BigInt(previous) || account.minimumAuthnEpoch === BigInt(previous + 1),
            );
            return account.minimumAuthnEpoch === BigInt(previous) ? 'execute' : 'receipt-only';
          },
        },
        receipt: {
          actorAccountId: stage.actingHumanId,
          kind: 'access.credential-floor',
          key: `${route}:${opening.receiptId}`,
          digest,
        },
      },
      async (tx, command) => {
        const before = await readAccount(tx, route!, stage.subjectAccountId);
        allowed(before && before.minimumAuthnEpoch === BigInt(previous));
        const rows = await credentialAdvance.run(tx, {
          ...parameters,
          receipt_id: newId(route!),
          transaction_id: command.transactionId,
          operation_key: stage.operationKey,
          effect_reference: stage.effectReference,
          effect_digest: stage.effectDigest,
          purpose: stage.purpose,
          previous_floor: previous,
          fenced: before.fenced,
        });
        allowed(rows[0]);
        return {
          value: rows[0],
          events: [
            {
              type: 'com.rezics.access.credential-floor-advanced.v1',
              subject: stage.subjectAccountId,
              data: { openingReceiptId: opening.receiptId },
            },
          ],
        };
      },
    );
    const committed = await receipt();
    const after = await readAccount(config.pool, route!, stage.subjectAccountId);
    allowed(
      committed &&
        after &&
        committed.receiptId === result.value.receiptId &&
        committed.accountId === stage.subjectAccountId &&
        committed.openingReceiptId === opening.receiptId &&
        committed.operationKey === stage.operationKey &&
        committed.purpose === stage.purpose &&
        committed.effectReference === stage.effectReference &&
        committed.effectDigest === stage.effectDigest &&
        committed.previousFloor === previous &&
        committed.minimumAuthnEpoch === previous + 1 &&
        after.minimumAuthnEpoch === BigInt(previous + 1) &&
        after.fenced === committed.fenced &&
        after.state === 'active',
    );
    return committed;
  };
}
