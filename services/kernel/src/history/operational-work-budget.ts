import type { Pool } from 'pg';
import { currentOperationalResources, type OperationalTransaction } from '../command/operational.ts';

/** The eight native axes. This allocation belongs only to the operational History producer. */
export const OPERATIONAL_WORK_AXES = [
  'candidateKeys', 'nativeRows', 'identityMetadataRows', 'emptySeeks',
  'nativePoints', 'witnessKeys', 'statements', 'bytes',
] as const;
export type OperationalWorkCost = Readonly<Record<(typeof OPERATIONAL_WORK_AXES)[number], number>>;
const cost = (nativeRows: number, nativePoints: number, statements: number, bytes: number): OperationalWorkCost =>
  Object.freeze({ candidateKeys: 0, nativeRows, identityMetadataRows: 0, emptySeeks: nativePoints,
    nativePoints, witnessKeys: 0, statements, bytes });
export function sumOperationalWork(...parts: readonly OperationalWorkCost[]): OperationalWorkCost {
  return Object.freeze(Object.fromEntries(OPERATIONAL_WORK_AXES.map(axis =>
    [axis, parts.reduce((total, part) => total + part[axis], 0)]))) as OperationalWorkCost;
}
const times = (n: number, part: OperationalWorkCost) => sumOperationalWork(...Array.from({ length: n }, () => part));

// Each family touch: erasure, fence including its FK, and up to nine coverage rows.
// Each locator INSERT additionally touches its (at most eight) exact role associations.
// This producer preserves all Access identity roles; it never reduces them to payload accounts.
const touch = cost(12, 12, 4, 0);
// Base: INSERT/FK, existing native identity-enrollment empty association probe, seal
// INSERT/read guard, operational scope's two full-key probes, and eight artifact role keys.
const locator = sumOperationalWork(cost(16, 16, 8, 8192), times(9, touch));
export const OPERATIONAL_WORK_COST = Object.freeze({
  // Time transaction: BEGIN/settings/time/COMMIT/ROLLBACK. Source transaction:
  // BEGIN/two settings/operational fence/final setting/COMMIT/ROLLBACK; two Account locks.
  attempt: cost(7, 3, 14, 768),
  originalLookup: cost(1, 1, 1, 1024),
  sourceDomain: cost(1, 1, 1, 128),
  // Eight physical LIMIT 1 probes. SDK status upsert: INSERT and conflict UPDATE guards;
  // input INSERT guard; exact input readback. Each guard locks the native writer.
  sdkProbe: cost(8, 8, 8, 256),
  sdkProjectionGuard: cost(2, 2, 1, 128),
  sdkEnqueue: cost(10, 10, 9, 16384),
  sdkWriter: cost(4, 4, 1, 12288),
  // Bound original JSON columns, episode reservation argument, sixteen UUID associations and
  // scalar keys separately. A zero-byte INSERT would omit the actual producer serialization.
  originalInsert: cost(34, 34, 19, 262144 + 8192 + 4096 + 1024 + 196608 + 16 * 128 + 4096),
  originalFinalize: cost(3, 3, 3, 256), // partition epoch lock, exact association seal, deferred seal verification
  seal: sumOperationalWork(cost(3, 3, 3, 128), touch),
  workInsert: cost(2, 2, 2, 8192 + 4096 + 512), // work and partition FK; INSERT has no physical-change trigger
  locator,
  // A released source read: BEGIN/setting/key/current partition/domain/COMMIT/ROLLBACK.
  resolve: cost(4, 3, 7, 290816),
  // Receiving BEGIN/settings/partition/domain/COMMIT/ROLLBACK. Mapping insert has its
  // partition FK. Mapping readback, work readback and all eight locator role keys follow.
  receivingControl: cost(4, 2, 7, 512),
  mappingInsert: cost(2, 2, 2, 278528 + 1024 + 1024),
  mappingRead: cost(11, 11, 3, 299008),
  sdkReadback: cost(2, 2, 2, 9216),
  // Actual SDK check_workflow_writer_state: SELECT, domain lock, writer lock, return.
  writerBarrier: cost(4, 2, 4, 8192),
  replaySeals: cost(8, 8, 8, 1024),
});

export const OPERATIONAL_WORK_REGISTRATION = sumOperationalWork(
  OPERATIONAL_WORK_COST.originalLookup, OPERATIONAL_WORK_COST.sourceDomain,
  OPERATIONAL_WORK_COST.sdkProbe, OPERATIONAL_WORK_COST.sdkEnqueue, OPERATIONAL_WORK_COST.sdkWriter,
  OPERATIONAL_WORK_COST.sdkProjectionGuard,
  OPERATIONAL_WORK_COST.originalInsert, OPERATIONAL_WORK_COST.originalFinalize,
  times(8, OPERATIONAL_WORK_COST.seal), OPERATIONAL_WORK_COST.workInsert, times(8, locator),
);
export const OPERATIONAL_WORK_RECEIVING = sumOperationalWork(
  OPERATIONAL_WORK_COST.receivingControl, OPERATIONAL_WORK_COST.mappingInsert,
  OPERATIONAL_WORK_COST.mappingRead, OPERATIONAL_WORK_COST.writerBarrier,
  OPERATIONAL_WORK_COST.sdkReadback,
  times(8, OPERATIONAL_WORK_COST.seal), OPERATIONAL_WORK_COST.workInsert, times(8, locator),
);
export const OPERATIONAL_WORK_RECHECK = sumOperationalWork(
  OPERATIONAL_WORK_COST.receivingControl, OPERATIONAL_WORK_COST.mappingRead,
  OPERATIONAL_WORK_COST.writerBarrier, OPERATIONAL_WORK_COST.sdkReadback,
  OPERATIONAL_WORK_COST.replaySeals,
);
export const OPERATIONAL_WORK_TRANSFER_COST = Object.freeze({
  resolve: OPERATIONAL_WORK_COST.resolve,
  receive: OPERATIONAL_WORK_RECEIVING,
  replay: OPERATIONAL_WORK_RECHECK,
  retirement: OPERATIONAL_WORK_RECHECK,
});
export type OperationalWorkPhase = keyof typeof OPERATIONAL_WORK_TRANSFER_COST;
/** Three complete attempts share ONE balance. Rollback and failed prefixes are never refunded.
 * The caller's Members/Source/Access bodies are separate declarations, not this child's price. */
export const OPERATIONAL_WORK_LOCAL_DECLARATION = sumOperationalWork(
  times(3, sumOperationalWork(OPERATIONAL_WORK_COST.attempt, OPERATIONAL_WORK_REGISTRATION,
    ...Object.values(OPERATIONAL_WORK_TRANSFER_COST))),
);

export class OperationalWorkUnavailable extends Error {
  constructor(readonly gap: string) { super(gap); }
}
export type OperationalWorkOriginal = Readonly<{ pool: Pool; deadline: number }>;
type Balance = { remaining: OperationalWorkCost; attempts: number };
const originals = new WeakMap<OperationalWorkOriginal, Balance>();
const transactionOriginals = new WeakMap<OperationalTransaction, OperationalWorkOriginal>();
export function attachOperationalWorkOriginal(tx: OperationalTransaction, original: OperationalWorkOriginal): void {
  const resources = currentOperationalResources(tx);
  if (transactionOriginals.has(tx) || resources.pool !== original.pool || resources.deadline !== original.deadline ||
    !originals.has(original)) throw new TypeError('Foreign or repeated operational History original');
  transactionOriginals.set(tx, original);
}
export function openOperationalWorkOriginal(pool: Pool, deadline: number): OperationalWorkOriginal {
  const original = Object.freeze({ pool, deadline });
  originals.set(original, { remaining: OPERATIONAL_WORK_LOCAL_DECLARATION, attempts: 0 });
  return original;
}
export function debitOperationalWork(original: OperationalWorkOriginal, amount: OperationalWorkCost): void {
  const balance = originals.get(original);
  if (!balance || Date.now() >= original.deadline ||
    OPERATIONAL_WORK_AXES.some(axis => !Number.isSafeInteger(amount[axis]) || amount[axis] < 0 ||
      amount[axis] > balance.remaining[axis]))
    throw new OperationalWorkUnavailable('operational-work-native-funding-unavailable');
  balance.remaining = Object.freeze(Object.fromEntries(OPERATIONAL_WORK_AXES.map(axis =>
    [axis, balance.remaining[axis] - amount[axis]]))) as OperationalWorkCost;
}
export function debitOperationalWorkAttempt(original: OperationalWorkOriginal): void {
  const balance = originals.get(original);
  if (!balance || ++balance.attempts > 3)
    throw new OperationalWorkUnavailable('operational-work-original-attempt-bound');
  debitOperationalWork(original, OPERATIONAL_WORK_COST.attempt);
}

declare const transfer: unique symbol;
export type OperationalWorkTransfer = { readonly [transfer]: true };
type Transfer = { original: OperationalWorkOriginal; phase: OperationalWorkPhase;
  custodyId: string; state: 'live' | 'committed' | 'invalid'; used: boolean };
const transfers = new WeakMap<OperationalWorkTransfer, Transfer>();
const byTransaction = new WeakMap<OperationalTransaction, Set<OperationalWorkTransfer>>();
/** Executor/producer internal. Public issuance verifies the genuine live transaction first. */
export function issueOperationalWorkTransfer(
  tx: OperationalTransaction, original: OperationalWorkOriginal, phase: OperationalWorkPhase, custodyId: string,
): OperationalWorkTransfer {
  const resources = currentOperationalResources(tx);
  if (transactionOriginals.get(tx) !== original || resources.pool !== original.pool || resources.deadline !== original.deadline)
    throw new OperationalWorkUnavailable('operational-work-native-transfer-unavailable');
  const issued = byTransaction.get(tx) ?? new Set<OperationalWorkTransfer>();
  if ([...issued].some(token => transfers.get(token)?.phase === phase))
    throw new TypeError('Operational work phase already transferred');
  debitOperationalWork(original, OPERATIONAL_WORK_TRANSFER_COST[phase]);
  const token = Object.freeze({}) as OperationalWorkTransfer;
  transfers.set(token, { original, phase, custodyId, state: 'live', used: false });
  issued.add(token);
  byTransaction.set(tx, issued);
  return token;
}
export function finishOperationalWorkTransfers(tx: OperationalTransaction, committed: boolean): void {
  for (const token of byTransaction.get(tx) ?? []) {
    const binding = transfers.get(token)!;
    binding.state = committed ? 'committed' : 'invalid';
  }
  byTransaction.delete(tx);
  transactionOriginals.delete(tx);
}
export function consumeOperationalWorkTransfer(
  pool: Pool, token: OperationalWorkTransfer, phase: OperationalWorkPhase, custodyId: string,
): Readonly<{ deadline: number }> {
  const bound = transfers.get(token);
  if (!bound || bound.used || bound.phase !== phase || bound.custodyId !== custodyId || bound.state !== 'committed' ||
    bound.original.pool !== pool || Date.now() >= bound.original.deadline)
    throw new OperationalWorkUnavailable('operational-work-native-transfer-unavailable');
  bound.used = true;
  return Object.freeze({ deadline: bound.original.deadline });
}
