import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import {
  currentCommand,
  currentCommandResources,
  registerCommandCallback,
  type CommandEvent,
  type CommandTransaction,
} from '../command/command.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import type { IdentityJobRef } from './identity-epoch-contract.ts';
import type { IdentityScopeKey } from './identity-scope-types.ts';
import { identityScopeAddress } from './identity-scoped-observations.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  identitySourceConsumerLibraryWork,
  type IdentitySourceConsumerMaintenanceContext,
} from './identity-source-consumer-maintenance.ts';
import { recordIdentityEpochNativeCommit, serializeIdentityValue as json } from './identity-epoch-store.ts';
import { IDENTITY_SCOPE_NATIVE_ASSOCIATED, IDENTITY_SCOPE_DIRECTORY_ENROLLED } from './events.ts';
import insert from './identity-scope-native-association-insert.sql';
import native from './identity-epoch-store-insert-native-commit.sql';
import fence from '../command/fence.sql';
import time from '../command/time.sql';

type Phase = 'registration' | 'capture' | 'enrollment' | 'ready' | 'progress' | 'finish';
type Purpose = 'identity-scope-registration' | 'identity-scope-enrollment' | 'identity-scope-finish';
declare const admission: unique symbol;
export type IdentityScopeNativeAssociationAdmission = Readonly<{ deadline: number; [admission]: true }>;
type Binding = {
  pool: Pool;
  context: IdentitySourceConsumerMaintenanceContext;
  work: NativeCollectionWork;
  tx?: CommandTransaction;
  queued: boolean;
};
const bindings = new WeakMap<IdentityScopeNativeAssociationAdmission, Binding>();
const zero = {
  candidateKeys: 0,
  identityMetadataRows: 0,
  nativeRows: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
  emptySeeks: 0,
};
const price = (rows: number, statements: number, bytes: number): WorkDimensions =>
  Object.freeze({ ...zero, nativeRows: rows, nativePoints: rows, statements, bytes });

/** Fixed additive bounds on every dispatch, including misses, repeats and rollback.
 * Bytes include schema maxima, SQL text and a scalar output envelope. The original
 * observation operations retain their existing admission; this pays every added
 * native component/association/event plus both terminal alternatives before IO.
 */
export const identityScopeNativeAssociationPrices = Object.freeze({
  native: price(2, 1, Buffer.byteLength(native.sql) + 256 + 64),
  association: price(8, 1, Buffer.byteLength(insert.sql) + 6656 + 64),
  event: price(2, 1, Buffer.byteLength(fence.sql) + 2048 + 64),
  // time point, checkout, BEGIN, lock timeout, two statement timeouts, COMMIT,
  // ROLLBACK. Both terminals stay charged on success as well as rollback.
  control: Object.freeze({
    ...price(
      1,
      7,
      Buffer.byteLength(time.sql) +
        Buffer.byteLength('BEGIN ISOLATION LEVEL SERIALIZABLE') +
        Buffer.byteLength("SET LOCAL lock_timeout = '200ms'") +
        2 * Buffer.byteLength("SET LOCAL statement_timeout = '9999999999999999ms'") +
        Buffer.byteLength('COMMITROLLBACK') +
        128,
    ),
    nativePoints: 2,
  }),
});

/** Admission from the CURRENT original only, before starting the narrow command.
 * No allowance, configuration, or caller-created work object is accepted here.
 */
export function prepayIdentityScopeNativeAssociation(
  pool: Pool,
  deadline: number,
): IdentityScopeNativeAssociationAdmission {
  const context = activeIdentitySourceConsumerMaintenance(pool);
  const effective = Math.min(deadline, context?.deadline ?? NaN);
  const work = context && identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, effective);
  if (!context || !work || !Number.isSafeInteger(effective) || effective <= Date.now())
    throw new ProblemError('dependency_unavailable');
  const total = { ...zero };
  for (const cost of Object.values(identityScopeNativeAssociationPrices))
    for (const axis of Object.keys(total) as (keyof WorkDimensions)[]) total[axis] += cost[axis];
  const reserved = work.reserve(total);
  reserved.dispatch();
  reserved.settle(); // fixed operation bounds; no success/absence/rollback refund
  const token = Object.freeze({ deadline: effective }) as IdentityScopeNativeAssociationAdmission;
  bindings.set(token, { pool, context: { ...context, deadline: effective }, work, queued: false });
  return token;
}

/** Bind exactly one genuine command. Retries need a new dispatch and cannot reuse
 * this debit; a callback, foreign Pool or settled original cannot escape its frame.
 */
export function bindIdentityScopeNativeAssociation(
  tx: CommandTransaction,
  token: IdentityScopeNativeAssociationAdmission,
): void {
  const b = bindings.get(token);
  if (
    !b ||
    b.work.failure ||
    (b.tx && b.tx !== tx) ||
    currentCommandResources(tx).pool !== b.pool ||
    currentCommandResources(tx).deadline !== token.deadline ||
    identitySourceConsumerLibraryWork(b.pool, b.context.identityConsumerWork, token.deadline) !== b.work
  )
    throw new ProblemError('dependency_unavailable');
  // Released hooks are platform commands. An attributed command may write a
  // basis/receipt as well, which this fixed native/event package does not admit.
  if (currentCommand(tx).basis !== null) throw new ProblemError('dependency_unavailable');
  b.tx = tx;
}

/** Queue after the actual domain write. Native insertion precedes association in
 * the executor's callback list. Neither the event nor this return is a receipt.
 */
export function recordIdentityScopeNativeAssociation(
  tx: CommandTransaction,
  token: IdentityScopeNativeAssociationAdmission,
  key: IdentityScopeKey,
  phase: Phase,
  binding?: Readonly<{ job?: IdentityJobRef; dependency?: string }>,
): CommandEvent {
  bindIdentityScopeNativeAssociation(tx, token);
  const b = bindings.get(token)!;
  if (b.queued) throw new TypeError('Scope association already queued');
  b.queued = true;
  key = structuredClone(key);
  binding = structuredClone(binding);
  const address = identityScopeAddress(key);
  const command = currentCommand(tx);
  if (address.partition !== command.partition) throw new TypeError('Foreign scope association home');
  const purpose: Purpose =
    phase === 'finish'
      ? 'identity-scope-finish'
      : phase === 'enrollment'
        ? 'identity-scope-enrollment'
        : 'identity-scope-registration';
  registerCommandCallback(tx, () => bindIdentityScopeNativeAssociation(tx, token));
  recordIdentityEpochNativeCommit(tx, purpose);
  registerCommandCallback(tx, async (transactionId) => {
    bindIdentityScopeNativeAssociation(tx, token);
    if (transactionId !== command.transactionId) throw new TypeError('Foreign scope association transaction');
    const result = await tx.query(insert.sql, [
      address.partition,
      address.source,
      address.scope,
      json(key.source),
      transactionId,
      phase,
      purpose,
      binding?.dependency ?? null,
      binding?.job?.jobId ?? null,
      binding?.job?.epoch.toString() ?? null,
    ]);
    if (result.rowCount !== 1) throw new ProblemError('dependency_unavailable');
  });
  return {
    type: IDENTITY_SCOPE_NATIVE_ASSOCIATED,
    data: {
      sourceKey: address.source,
      scope: address.scope,
      phase,
      transactionId: command.transactionId,
    },
  };
}

/** Directory enrollment commits on the dependency's home, rather than the Source's.
 * Its real inverse and native receipt share this transaction; it is not a Source association.
 */
export function recordIdentityScopeDirectoryEnrollment(
  tx: CommandTransaction,
  token: IdentityScopeNativeAssociationAdmission,
  key: IdentityScopeKey,
): CommandEvent {
  bindIdentityScopeNativeAssociation(tx, token);
  const binding = bindings.get(token)!;
  if (binding.queued) throw new TypeError('Scope association already queued');
  binding.queued = true;
  const address = identityScopeAddress(key);
  registerCommandCallback(tx, () => bindIdentityScopeNativeAssociation(tx, token));
  recordIdentityEpochNativeCommit(tx, 'identity-scope-enrollment');
  return {
    type: IDENTITY_SCOPE_DIRECTORY_ENROLLED,
    data: { sourceKey: address.source, scope: address.scope, transactionId: currentCommand(tx).transactionId },
  };
}
