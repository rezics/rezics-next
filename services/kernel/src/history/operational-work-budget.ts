import type { Pool, PoolClient } from 'pg';
import { currentOperationalResources, type OperationalTransaction } from '../command/operational.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { WorkClient } from '../work/client.ts';

/** The eight native axes. This allocation belongs only to the operational History producer. */
export const OPERATIONAL_WORK_AXES = [
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'emptySeeks',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
] as const;
export type OperationalWorkCost = Readonly<Record<(typeof OPERATIONAL_WORK_AXES)[number], number>>;
const cost = (nativeRows: number, nativePoints: number, statements: number, bytes: number): OperationalWorkCost =>
  Object.freeze({
    candidateKeys: 0,
    nativeRows,
    identityMetadataRows: 0,
    emptySeeks: nativePoints,
    nativePoints,
    witnessKeys: 0,
    statements,
    bytes,
  });
export function sumOperationalWork(...parts: readonly OperationalWorkCost[]): OperationalWorkCost {
  if (parts.some((part) => OPERATIONAL_WORK_AXES.some((axis) => !Number.isSafeInteger(part[axis]) || part[axis] < 0)))
    throw new TypeError('Invalid operational work declaration');
  const total = Object.freeze(
    Object.fromEntries(
      OPERATIONAL_WORK_AXES.map((axis) => [axis, parts.reduce((total, part) => total + part[axis], 0)]),
    ),
  ) as OperationalWorkCost;
  if (OPERATIONAL_WORK_AXES.some((axis) => !Number.isSafeInteger(total[axis])))
    throw new TypeError('Operational work declaration overflow');
  return total;
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
  originalLookup: cost(1, 1, 1, 1280),
  sourceDomain: cost(1, 1, 1, 128),
  // Allocator SELECT partition (1), head insert/conflict update (2), both BEFORE triggers'
  // partition/domain reads (4), partition FK (1), deferred head->original exact probe (1).
  // Four further head PK insert/conflict/update index touches; no sequence or free control I/O.
  // Params/RETURNING include UUIDs, digest, workflow, deadline and the complete stamp (<=256).
  positionAllocate: cost(9, 13, 7, 2048),
  // Original insert binds every position operand against the locked head (1 point/statement).
  positionBinding: cost(1, 1, 1, 512),
  // Three original unique keys + PK + new partial position index, sixteen episode PKs;
  // final original UPDATE maintains its five indexes (source_epoch/sealed change).
  originalIndexes: cost(0, 26, 0, 1024),
  // Eight physical LIMIT 1 probes. SDK status upsert: INSERT and conflict UPDATE guards;
  // input INSERT guard; exact input readback. Each guard locks the native writer.
  sdkProbe: cost(8, 8, 8, 256),
  sdkDomain: cost(1, 1, 1, 128), // source restore-domain SHARE precedes every SDK writer lock
  sdkProjectionGuard: cost(2, 2, 1, 128),
  // 4096-byte returned status + 8192-byte input callback + 4096-byte original input,
  // with 2048 bytes for fixed SDK status/queue/UUID/serialization arguments.
  sdkEnqueue: cost(10, 10, 9, 18432),
  // 4096-byte bounded older creator projection + 8192-byte input + 512 fence scalars.
  sdkWriter: cost(4, 4, 1, 12800),
  // Bound original JSON columns, episode reservation argument, sixteen UUID associations and
  // scalar keys separately. A zero-byte INSERT would omit the actual producer serialization.
  originalInsert: cost(34, 34, 19, 262144 + 8192 + 4096 + 1024 + 196608 + 16 * 128 + 4096),
  originalFinalize: cost(6, 6, 5, 2048), // UPDATE partition/association + deferred original/partition/domain/head reads and deadline
  seal: sumOperationalWork(cost(3, 3, 3, 128), touch),
  workInsert: cost(2, 2, 2, 8192 + 4096 + 512), // work and partition FK; INSERT has no physical-change trigger
  locator,
  // Held partition/domain/head/original (4), BEGIN/two settings/COMMIT/ROLLBACK (5).
  // Bounded original projection + scalar keys + stamp JSON and comparison serialization.
  resolve: cost(4, 4, 9, 291328),
  // Receiving BEGIN/settings/partition/domain/COMMIT/ROLLBACK. Mapping insert has its
  // partition FK. Mapping readback, work readback and all eight locator role keys follow.
  receivingControl: cost(4, 2, 8, 640),
  // Native mapping row/FK, PK/workflow/partial-position index operations (3),
  // pure mapping-stamp trigger (no SQL) and <=256-byte discriminated stamp projection.
  mappingInsert: cost(2, 5, 2, 278528 + 1024 + 1024 + 512),
  mappingRead: cost(11, 11, 3, 299520),
  sdkReadback: cost(2, 2, 2, 9216),
  // Actual SDK check_workflow_writer_state: SELECT, domain lock, writer lock, return.
  writerBarrier: cost(4, 2, 4, 8192),
  replaySeals: cost(8, 8, 8, 1024),
});

export const OPERATIONAL_WORK_REGISTRATION = sumOperationalWork(
  OPERATIONAL_WORK_COST.originalLookup,
  OPERATIONAL_WORK_COST.sourceDomain,
  OPERATIONAL_WORK_COST.positionAllocate,
  OPERATIONAL_WORK_COST.positionBinding,
  OPERATIONAL_WORK_COST.originalIndexes,
  OPERATIONAL_WORK_COST.sdkDomain,
  OPERATIONAL_WORK_COST.sdkProbe,
  OPERATIONAL_WORK_COST.sdkEnqueue,
  OPERATIONAL_WORK_COST.sdkWriter,
  OPERATIONAL_WORK_COST.sdkProjectionGuard,
  OPERATIONAL_WORK_COST.originalInsert,
  OPERATIONAL_WORK_COST.originalFinalize,
  times(8, OPERATIONAL_WORK_COST.seal),
  OPERATIONAL_WORK_COST.workInsert,
  times(8, locator),
);
export const OPERATIONAL_WORK_RECEIVING = sumOperationalWork(
  OPERATIONAL_WORK_COST.receivingControl,
  OPERATIONAL_WORK_COST.mappingInsert,
  OPERATIONAL_WORK_COST.mappingRead,
  OPERATIONAL_WORK_COST.writerBarrier,
  OPERATIONAL_WORK_COST.sdkReadback,
  times(8, OPERATIONAL_WORK_COST.seal),
  OPERATIONAL_WORK_COST.workInsert,
  times(8, locator),
);
export const OPERATIONAL_WORK_RECHECK = sumOperationalWork(
  OPERATIONAL_WORK_COST.receivingControl,
  OPERATIONAL_WORK_COST.mappingRead,
  OPERATIONAL_WORK_COST.writerBarrier,
  OPERATIONAL_WORK_COST.sdkReadback,
  OPERATIONAL_WORK_COST.replaySeals,
);
export const OPERATIONAL_WORK_TRANSFER_COST = Object.freeze({
  resolve: OPERATIONAL_WORK_COST.resolve,
  verify: OPERATIONAL_WORK_COST.resolve,
  receive: OPERATIONAL_WORK_RECEIVING,
  replay: OPERATIONAL_WORK_RECHECK,
  retirement: OPERATIONAL_WORK_RECHECK,
});
export type OperationalWorkPhase = keyof typeof OPERATIONAL_WORK_TRANSFER_COST;
/** Three complete attempts share ONE balance. Rollback and failed prefixes are never refunded.
 * The caller's Members/Source/Access bodies are separate declarations, not this child's price. */
export const OPERATIONAL_WORK_LOCAL_DECLARATION = sumOperationalWork(
  times(
    3,
    sumOperationalWork(
      OPERATIONAL_WORK_COST.attempt,
      OPERATIONAL_WORK_REGISTRATION,
      ...Object.values(OPERATIONAL_WORK_TRANSFER_COST),
    ),
  ),
);

export class OperationalWorkUnavailable extends Error {
  constructor(readonly gap: string) {
    super(gap);
  }
}
/** Query adapter over the SAME checked-out client. A wait for a connection/lock never
 * extends the original deadline. Cleanup uses the raw client so expiry cannot prevent rollback. */
export function operationalWorkDeadlineClient(client: PoolClient, deadline: number): Pick<PoolClient, 'query'> {
  return {
    query: new Proxy(client.query, {
      apply(target, _receiver, args) {
        if (Date.now() >= deadline) throw new OperationalWorkUnavailable('operational-work-deadline');
        return Reflect.apply(target, client, args);
      },
    }),
  };
}
export type OperationalWorkOriginal = Readonly<{ pool: Pool; deadline: number; workClient?: WorkClient }>;
const CHILD_PRICES = Object.freeze({
  registration: OPERATIONAL_WORK_REGISTRATION,
  ...OPERATIONAL_WORK_TRANSFER_COST,
  attempt: OPERATIONAL_WORK_COST.attempt,
});
type FundedPhase = keyof typeof CHILD_PRICES;
/** Already allocated children of one caller original. Retry is additional work, never a refill. */
export type OperationalWorkChildren = Readonly<Record<FundedPhase | 'retry', NativeCollectionWork>>;
type Balance = { claimed: boolean } &
  (
    | { kind: 'local'; remaining: OperationalWorkCost; attempts: number }
    | { kind: 'children'; children: OperationalWorkChildren; used: Set<FundedPhase> }
  );
const originals = new WeakMap<OperationalWorkOriginal, Balance>();
const fundedChildren = new WeakSet<NativeCollectionWork>();
const transactionOriginals = new WeakMap<OperationalTransaction, OperationalWorkOriginal>();
export function attachOperationalWorkOriginal(tx: OperationalTransaction, original: OperationalWorkOriginal): void {
  const resources = currentOperationalResources(tx);
  if (
    transactionOriginals.has(tx) ||
    resources.pool !== original.pool ||
    resources.deadline !== original.deadline ||
    (original.workClient !== undefined && resources.workClient !== original.workClient) ||
    !originals.get(original)?.claimed
  )
    throw new TypeError('Foreign or repeated operational History original');
  transactionOriginals.set(tx, original);
}
export function openOperationalWorkOriginal(pool: Pool, deadline: number): OperationalWorkOriginal {
  if (!Number.isFinite(deadline) || Date.now() >= deadline)
    throw new OperationalWorkUnavailable('operational-work-deadline');
  const original = Object.freeze({ pool, deadline });
  originals.set(original, { kind: 'local', remaining: OPERATIONAL_WORK_LOCAL_DECLARATION, attempts: 0, claimed: false });
  return original;
}
/** Trusted parent composition: the complete History child, including retries, transfers and rollback,
 * is charged before dispatch. A failed or unused child never returns this allocation to its parent. */
export function fundOperationalWorkOriginal(
  parent: NativeCollectionWork,
  pool: Pool,
  workClient: WorkClient,
  deadline: number,
): OperationalWorkOriginal {
  if (parent.deadlineAt !== deadline) throw new TypeError('Foreign operational History deadline');
  const reservation = parent.reserve(OPERATIONAL_WORK_LOCAL_DECLARATION);
  reservation.dispatch();
  reservation.settle();
  const original = Object.freeze({ pool, workClient, deadline });
  originals.set(original, { kind: 'local', remaining: OPERATIONAL_WORK_LOCAL_DECLARATION, attempts: 0, claimed: false });
  return original;
}
/** Bind the native executor to prepaid caller children without creating a balance from a subtotal.
 * No I/O or charge occurs here. Each phase dispatches its exported price before its native work;
 * failed prefixes retain that charge. Additional attempts use only the original retry allocation.
 * The native executor keeps its absolute deadline policy, with no additional attempt-count cap.
 */
export function fundOperationalWorkChildren(
  children: OperationalWorkChildren,
  pool: Pool,
  workClient: WorkClient,
  deadline: number,
): OperationalWorkOriginal {
  if (!Number.isFinite(deadline) || Date.now() >= deadline)
    throw new OperationalWorkUnavailable('operational-work-deadline');
  const names = [...Object.keys(CHILD_PRICES), 'retry'] as (keyof OperationalWorkChildren)[];
  const snapshot = Object.create(null) as Record<keyof OperationalWorkChildren, NativeCollectionWork>;
  const unique = new Set<NativeCollectionWork>();
  // Validate the entire binding before marking any child consumed. No partial binding on refusal.
  for (const name of names) {
    const child = Object.hasOwn(children, name) ? children[name] : undefined;
    if (!child || unique.has(child) || fundedChildren.has(child) || child.deadlineAt !== deadline)
      throw new OperationalWorkUnavailable('operational-work-native-funding-unavailable');
    child.assertReady();
    const price = name === 'retry' ? undefined : CHILD_PRICES[name];
    if (price && OPERATIONAL_WORK_AXES.some((axis) => child.available(axis) < price[axis]))
      throw new OperationalWorkUnavailable('operational-work-native-funding-unavailable');
    snapshot[name] = child;
    unique.add(child);
  }
  for (const child of unique) fundedChildren.add(child);
  const original = Object.freeze({ pool, workClient, deadline });
  originals.set(original, {
    kind: 'children',
    children: Object.freeze(snapshot),
    used: new Set(),
    claimed: false,
  });
  return original;
}
/** Executor entry, before time, Access, checkout or BEGIN. Contention retains this same original. */
export function claimOperationalWorkOriginal(
  original: OperationalWorkOriginal,
  pool: Pool,
  workClient: WorkClient,
  deadline: number,
): OperationalWorkOriginal {
  const balance = originals.get(original);
  if (
    !balance ||
    balance.claimed ||
    original.pool !== pool ||
    original.deadline !== deadline ||
    (original.workClient !== undefined && original.workClient !== workClient) ||
    Date.now() >= deadline
  )
    throw new OperationalWorkUnavailable('operational-work-original-unavailable');
  balance.claimed = true;
  return original;
}
export function debitOperationalWork(original: OperationalWorkOriginal, amount: OperationalWorkCost): void {
  debitPhase(original, 'registration', amount);
}
function debitPhase(original: OperationalWorkOriginal, phase: FundedPhase, amount: OperationalWorkCost): void {
  const balance = originals.get(original);
  if (balance?.kind === 'children') {
    if (
      !balance.claimed ||
      Date.now() >= original.deadline ||
      OPERATIONAL_WORK_AXES.some((axis) => amount[axis] !== CHILD_PRICES[phase][axis])
    )
      throw new OperationalWorkUnavailable('operational-work-native-funding-unavailable');
    const child = balance.children[balance.used.has(phase) ? 'retry' : phase];
    const reservation = child.reserve(amount);
    reservation.dispatch();
    reservation.settle();
    balance.used.add(phase);
    return;
  }
  if (
    !balance ||
    Date.now() >= original.deadline ||
    OPERATIONAL_WORK_AXES.some(
      (axis) => !Number.isSafeInteger(amount[axis]) || amount[axis] < 0 || amount[axis] > balance.remaining[axis],
    )
  )
    throw new OperationalWorkUnavailable('operational-work-native-funding-unavailable');
  balance.remaining = Object.freeze(
    Object.fromEntries(OPERATIONAL_WORK_AXES.map((axis) => [axis, balance.remaining[axis] - amount[axis]])),
  ) as OperationalWorkCost;
}
export function debitOperationalWorkAttempt(original: OperationalWorkOriginal): void {
  const balance = originals.get(original);
  if (balance?.kind === 'children') {
    debitPhase(original, 'attempt', OPERATIONAL_WORK_COST.attempt);
    return;
  }
  if (!balance || ++balance.attempts > 3)
    throw new OperationalWorkUnavailable('operational-work-original-attempt-bound');
  debitOperationalWork(original, OPERATIONAL_WORK_COST.attempt);
}

declare const transfer: unique symbol;
export type OperationalWorkTransfer = { readonly [transfer]: true };
type Transfer = {
  original: OperationalWorkOriginal;
  phase: OperationalWorkPhase;
  custodyId: string;
  state: 'live' | 'committed' | 'invalid';
  used: boolean;
};
const transfers = new WeakMap<OperationalWorkTransfer, Transfer>();
const byTransaction = new WeakMap<OperationalTransaction, Set<OperationalWorkTransfer>>();
/** Executor/producer internal. Public issuance verifies the genuine live transaction first. */
export function issueOperationalWorkTransfer(
  tx: OperationalTransaction,
  original: OperationalWorkOriginal,
  phase: OperationalWorkPhase,
  custodyId: string,
): OperationalWorkTransfer {
  const resources = currentOperationalResources(tx);
  if (
    transactionOriginals.get(tx) !== original ||
    resources.pool !== original.pool ||
    resources.deadline !== original.deadline
  )
    throw new OperationalWorkUnavailable('operational-work-native-transfer-unavailable');
  const issued = byTransaction.get(tx) ?? new Set<OperationalWorkTransfer>();
  if ([...issued].some((token) => transfers.get(token)?.phase === phase))
    throw new TypeError('Operational work phase already transferred');
  debitPhase(original, phase, OPERATIONAL_WORK_TRANSFER_COST[phase]);
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
  pool: Pool,
  token: OperationalWorkTransfer,
  phase: OperationalWorkPhase,
  custodyId: string,
): Readonly<{ deadline: number }> {
  const bound = transfers.get(token);
  if (
    !bound ||
    bound.used ||
    bound.phase !== phase ||
    bound.custodyId !== custodyId ||
    bound.state !== 'committed' ||
    bound.original.pool !== pool ||
    Date.now() >= bound.original.deadline
  )
    throw new OperationalWorkUnavailable('operational-work-native-transfer-unavailable');
  bound.used = true;
  return Object.freeze({ deadline: bound.original.deadline });
}
